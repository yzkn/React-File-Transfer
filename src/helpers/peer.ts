import Peer, { DataConnection, PeerErrorType, PeerError } from "peerjs";
import { message } from "antd";
import { upsertTransfer } from "./transfers";

export enum DataType {
    FILE = 'FILE',
    OTHER = 'OTHER',
    // 受け手が FILE を受け取ったことを送り手に知らせる
    ACK = 'ACK',
    // 分割の送信: 送り手の申し出（名前・大きさ）→ 受け手の受け入れ / 断り → 分割 → 分割ごとの受領
    OFFER = 'OFFER',
    ACCEPT = 'ACCEPT',
    DECLINE = 'DECLINE',
    CHUNK = 'CHUNK',
    CHUNK_ACK = 'CHUNK_ACK'
}

export interface Data {
    dataType: DataType
    file?: Blob
    fileName?: string
    fileType?: string
    message?: string
    // 送り手が付ける転送ごとの ID。受け手は同じ ID で ACK を返す
    transferId?: string
    // OFFER: ファイルの大きさと分割の数
    size?: number
    totalChunks?: number
    // CHUNK: 何番目か（0 から）と中身 / CHUNK_ACK: 受け取り済みの数
    index?: number
    chunk?: ArrayBuffer
    received?: number
}

// 受け手に見せる申し出
export interface FileOffer {
    peerId: string
    transferId: string
    fileName: string
    fileType: string
    size: number
    // この時間を過ぎると送り手はあきらめる。確認の画面もこの時間で閉じる
    timeoutMs: number
}

// 接続の時間切れ（相手が応答しないとき）
const CONNECT_TIMEOUT_MS = 15000
// 一括の FILE の受け取りの知らせ（ACK）を待つ時間: 基本の時間 + 大きさに応じた時間（約 50KB/秒 を下限の速さとみる）
const ACK_TIMEOUT_BASE_MS = 60000
const ACK_BYTES_PER_MS = 50
// 分割の送信
export const CHUNK_SIZE = 256 * 1024
// 受領を待たずに送ってよい分割の数（送り過ぎて相手やブラウザーのバッファーをあふれさせない）
const CHUNK_WINDOW = 4
// 受け手が受け取るかどうかを決めるまで待つ時間
export const OFFER_TIMEOUT_MS = 5 * 60 * 1000
// 分割の受領が途切れたとみなす時間
const CHUNK_STALL_TIMEOUT_MS = 30000

export const DECLINED_ERROR = "Declined by peer"
export const NO_RESPONSE_ERROR = "No response from peer"

const newTransferId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)

interface PendingAck {
    peerId: string
    resolve: () => void
    reject: (err: Error) => void
}

// 送り手が、ある転送について相手から届く知らせ（ACCEPT・DECLINE・CHUNK_ACK・ACK）を順に待つための箱
class TransferInbox {
    private queue: Data[] = []
    private waiter?: { resolve: (d: Data) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> }
    private error?: Error

    constructor(public peerId: string) { }

    push(d: Data) {
        if (this.waiter) {
            const w = this.waiter
            this.waiter = undefined
            clearTimeout(w.timer)
            w.resolve(d)
        } else {
            this.queue.push(d)
        }
    }

    fail(err: Error) {
        this.error = err
        if (this.waiter) {
            const w = this.waiter
            this.waiter = undefined
            clearTimeout(w.timer)
            w.reject(err)
        }
    }

    next(timeoutMs: number, timeoutError: string): Promise<Data> {
        if (this.queue.length > 0) return Promise.resolve(this.queue.shift() as Data)
        if (this.error) return Promise.reject(this.error)
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.waiter = undefined
                reject(new Error(timeoutError))
            }, timeoutMs)
            this.waiter = { resolve, reject, timer }
        })
    }
}

// 受け手が組み立て中のファイル
interface IncomingFile {
    peerId: string
    fileName: string
    fileType: string
    size: number
    totalChunks: number
    chunks: ArrayBuffer[]
    received: number
    bytes: number
}

const generateId = () => {
    // 利用する文字は、形が似ていたり、音が似ているものを除いて定義
    const letters = 'AFHJKLRSUVWXYZ345678';
    const len = 4;

    let generated = '';
    for (var i = 0; i < len; i++) {
        generated += letters.charAt(Math.floor(Math.random() * letters.length));
    }

    return generated;
};


const PEERJS_ID = generateId();
const MAX_ID_RETRIES = 5;

let peer: Peer | undefined
let connectionMap: Map<string, DataConnection> = new Map<string, DataConnection>()
let pendingAcks: Map<string, PendingAck> = new Map<string, PendingAck>()
let sendInboxes: Map<string, TransferInbox> = new Map<string, TransferInbox>()
let incomingFiles: Map<string, IncomingFile> = new Map<string, IncomingFile>()

// 受け手が申し出を受け入れるか。画面が setOfferHandler で差し替える（既定は受け入れる）
let offerHandler: (offer: FileOffer) => Promise<boolean> = () => Promise.resolve(true)

// その相手への送信で、受け取りの知らせを待っているものをすべて失敗にする
const rejectPendingAcks = (peerId: string, err: Error) => {
    Array.from(pendingAcks.entries()).forEach(([transferId, pending]) => {
        if (pending.peerId === peerId) {
            pendingAcks.delete(transferId)
            pending.reject(err)
        }
    })
    Array.from(sendInboxes.values()).forEach((inbox) => {
        if (inbox.peerId === peerId) inbox.fail(err)
    })
    Array.from(incomingFiles.entries()).forEach(([transferId, inc]) => {
        if (inc.peerId === peerId) {
            incomingFiles.delete(transferId)
            upsertTransfer({ id: transferId, direction: 'receive', status: 'failed', error: err.message })
        }
    })
}

const toError = (err: unknown) => (err instanceof Error ? err : new Error(String(err)))

// 送り出す（送り出しの失敗は例外にする）
const sendRaw = async (conn: DataConnection, data: Data) => {
    const sent = conn.send(data) as unknown
    if (sent instanceof Promise) await sent
}

// 分割して送る。相手が受け入れ、全部を受け取ったら resolve する
const sendFileInChunks = async (conn: DataConnection, data: Data & { file: Blob }) => {
    const id = conn.peer
    const transferId = newTransferId()
    const file = data.file
    const fileName = data.fileName || 'file'
    const size = file.size
    const totalChunks = Math.max(1, Math.ceil(size / CHUNK_SIZE))
    const inbox = new TransferInbox(id)
    sendInboxes.set(transferId, inbox)
    upsertTransfer({ id: transferId, direction: 'send', peerId: id, fileName, size, done: 0, status: 'waiting' })
    try {
        await sendRaw(conn, {
            dataType: DataType.OFFER, transferId, fileName, fileType: data.fileType || file.type, size, totalChunks
        })
        // 受け手の確認を待つ
        const answer = await inbox.next(OFFER_TIMEOUT_MS, NO_RESPONSE_ERROR)
        if (answer.dataType === DataType.DECLINE) {
            throw new Error(DECLINED_ERROR)
        }
        if (answer.dataType !== DataType.ACCEPT) {
            throw new Error("Unexpected reply: " + answer.dataType)
        }
        upsertTransfer({ id: transferId, direction: 'send', status: 'active' })

        let next = 0
        let acked = 0
        while (acked < totalChunks) {
            while (next < totalChunks && next - acked < CHUNK_WINDOW) {
                const chunk = await file.slice(next * CHUNK_SIZE, Math.min(size, (next + 1) * CHUNK_SIZE)).arrayBuffer()
                await sendRaw(conn, { dataType: DataType.CHUNK, transferId, index: next, chunk })
                next++
            }
            const reply = await inbox.next(CHUNK_STALL_TIMEOUT_MS, "No acknowledgement from " + id)
            if (reply.dataType === DataType.CHUNK_ACK && typeof reply.received === 'number') {
                acked = Math.max(acked, reply.received)
                upsertTransfer({ id: transferId, direction: 'send', done: Math.min(size, acked * CHUNK_SIZE) })
            } else if (reply.dataType === DataType.DECLINE) {
                throw new Error(DECLINED_ERROR)
            }
        }
        // 組み立てが終わった知らせ
        for (; ;) {
            const reply = await inbox.next(CHUNK_STALL_TIMEOUT_MS, "No acknowledgement from " + id)
            if (reply.dataType === DataType.ACK) break
        }
        upsertTransfer({ id: transferId, direction: 'send', done: size, status: 'done' })
    } catch (err) {
        const e = toError(err)
        upsertTransfer({
            id: transferId, direction: 'send',
            status: e.message === DECLINED_ERROR ? 'declined' : 'failed', error: e.message
        })
        throw e
    } finally {
        sendInboxes.delete(transferId)
    }
}

const trackConnection = (conn: DataConnection) => {
    connectionMap.set(conn.peer, conn)
    conn.on('close', () => {
        rejectPendingAcks(conn.peer, new Error("Connection closed: " + conn.peer))
    }).on('error', (err) => {
        rejectPendingAcks(conn.peer, err)
    })
}

export const PeerConnection = {
    getPeer: () => peer,
    startPeerSession: () => new Promise<string>((resolve, reject) => {
        // 自分の ID が他と重なった（unavailable-id）ときは、ID を作り直して取り直す
        let retries = 0
        const start = (id: string) => {
            try {
                const p = new Peer(id)
                peer = p
                let opened = false
                p.on('open', (id) => {
                    opened = true
                    console.log('My ID: ' + id)
                    resolve(id)
                }).on('error', (err) => {
                    console.log(err)
                    if (!opened && err.type === 'unavailable-id') {
                        p.destroy()
                        if (retries < MAX_ID_RETRIES) {
                            retries++
                            start(generateId())
                        } else {
                            message.error('ID を取得できませんでした。ページを読み込み直してください')
                            reject(err)
                        }
                        return
                    }
                    // 相手が見つからないエラーは connectPeer の呼び出し側で表示する（二重に出さない）
                    if (err.type !== 'peer-unavailable') {
                        message.error(err.message)
                    }
                    // 準備（open）の前に失敗したら、待っている側に知らせる
                    if (!opened) {
                        reject(err)
                    }
                })
            } catch (err) {
                console.log(err)
                reject(err)
            }
        }
        start(PEERJS_ID)
    }),
    closePeerSession: () => new Promise<void>((resolve, reject) => {
        try {
            if (peer) {
                peer.destroy()
                peer = undefined
            }
            resolve()
        } catch (err) {
            console.log(err)
            reject(err)
        }
    }),
    connectPeer: (id: string) => new Promise<void>((resolve, reject) => {
        if (!peer) {
            reject(new Error("Peer doesn't start yet"))
            return
        }
        if (connectionMap.has(id)) {
            reject(new Error("Connection existed"))
            return
        }
        try {
            let conn = peer.connect(id, { reliable: true })
            if (!conn) {
                reject(new Error("Connection can't be established"))
            } else {
                let settled = false
                const finish = (err?: Error) => {
                    if (settled) return
                    settled = true
                    clearTimeout(timer)
                    peer?.removeListener('error', handlePeerError)
                    if (err) {
                        reject(err)
                    } else {
                        resolve()
                    }
                }
                const timer = setTimeout(() => {
                    conn.close()
                    finish(new Error("Connection timed out: " + id))
                }, CONNECT_TIMEOUT_MS)

                conn.on('open', function () {
                    console.log("Connect to: " + id)
                    trackConnection(conn)
                    finish()
                }).on('error', function (err) {
                    console.log(err)
                    finish(err)
                })

                // When the connection fails due to expiry, the error gets emmitted
                // to the peer instead of to the connection.
                // We need to handle this here to be able to fulfill the Promise.
                const handlePeerError = (err: PeerError<`${PeerErrorType}`>) => {
                    if (err.type === 'peer-unavailable') {
                        const messageSplit = err.message.split(' ')
                        const peerId = messageSplit[messageSplit.length - 1]
                        if (id === peerId) finish(err)
                    }
                }
                peer.on('error', handlePeerError);
            }
        } catch (err) {
            reject(err)
        }
    }),
    onIncomingConnection: (callback: (conn: DataConnection) => void) => {
        peer?.on('connection', function (conn) {
            console.log("Incoming connection: " + conn.peer)
            trackConnection(conn)
            callback(conn)
        });
    },
    onConnectionDisconnected: (id: string, callback: () => void) => {
        if (!peer) {
            throw new Error("Peer doesn't start yet")
        }
        if (!connectionMap.has(id)) {
            throw new Error("Connection didn't exist")
        }
        let conn = connectionMap.get(id);
        if (conn) {
            conn.on('close', function () {
                console.log("Connection closed: " + id)
                connectionMap.delete(id)
                callback()
            });
        }
    },
    // 受け手が申し出を受け入れるかを決める処理を差し替える（確認の画面を出すなど）
    setOfferHandler: (handler: (offer: FileOffer) => Promise<boolean>) => {
        offerHandler = handler
    },
    // 相手から受け取りの知らせ（ACK）が届いたら resolve する（送り出しただけでは resolve しない）。
    // ファイルは分割して送り、相手の受け入れと進み具合を transfers に書く
    sendConnection: (id: string, data: Data): Promise<void> => new Promise((resolve, reject) => {
        const conn = connectionMap.get(id)
        if (!conn || !conn.open) {
            reject(new Error("Connection didn't exist: " + id))
            return
        }
        if (data.dataType === DataType.FILE && data.file) {
            sendFileInChunks(conn, data as Data & { file: Blob }).then(resolve, reject)
            return
        }
        const transferId = newTransferId()
        const size = data.file ? data.file.size : 0
        const timer = setTimeout(() => {
            if (pendingAcks.delete(transferId)) {
                reject(new Error("No acknowledgement from " + id))
            }
        }, ACK_TIMEOUT_BASE_MS + Math.ceil(size / ACK_BYTES_PER_MS))
        pendingAcks.set(transferId, {
            peerId: id,
            resolve: () => { clearTimeout(timer); resolve() },
            reject: (err) => { clearTimeout(timer); reject(err) }
        })
        const fail = (err: unknown) => {
            const pending = pendingAcks.get(transferId)
            if (pending) {
                pendingAcks.delete(transferId)
                pending.reject(err instanceof Error ? err : new Error(String(err)))
            }
        }
        try {
            const sent = conn.send({ ...data, transferId }) as unknown
            if (sent instanceof Promise) {
                sent.catch(fail)
            }
        } catch (err) {
            fail(err)
        }
    }),
    onConnectionReceiveData: (id: string, callback: (f: Data) => void) => {
        if (!peer) {
            throw new Error("Peer doesn't start yet")
        }
        if (!connectionMap.has(id)) {
            throw new Error("Connection didn't exist")
        }
        let conn = connectionMap.get(id)
        if (conn) {
            const c = conn
            const reply = (d: Data) => {
                sendRaw(c, d).catch((err) => console.log(err))
            }
            conn.on('data', function (receivedData) {
                let data = receivedData as Data
                const transferId = data.transferId
                switch (data.dataType) {
                    case DataType.ACCEPT:
                    case DataType.DECLINE:
                    case DataType.CHUNK_ACK:
                    case DataType.ACK: {
                        // こちらから送ったものへの、相手からの知らせ
                        const inbox = transferId ? sendInboxes.get(transferId) : undefined
                        if (inbox && inbox.peerId === id) {
                            inbox.push(data)
                            return
                        }
                        const pending = transferId ? pendingAcks.get(transferId) : undefined
                        if (data.dataType === DataType.ACK && pending && pending.peerId === id) {
                            pendingAcks.delete(transferId as string)
                            pending.resolve()
                        }
                        return
                    }
                    case DataType.OFFER: {
                        if (!transferId) return
                        const offer: FileOffer = {
                            peerId: id,
                            transferId,
                            fileName: data.fileName || 'file',
                            fileType: data.fileType || '',
                            size: data.size || 0,
                            timeoutMs: OFFER_TIMEOUT_MS
                        }
                        upsertTransfer({
                            id: transferId, direction: 'receive', peerId: id,
                            fileName: offer.fileName, size: offer.size, done: 0, status: 'waiting'
                        })
                        offerHandler(offer).catch(() => false).then((accepted) => {
                            if (!accepted) {
                                upsertTransfer({ id: transferId, direction: 'receive', status: 'declined' })
                                reply({ dataType: DataType.DECLINE, transferId })
                                return
                            }
                            if (!c.open) {
                                upsertTransfer({ id: transferId, direction: 'receive', status: 'failed', error: "Connection closed: " + id })
                                return
                            }
                            incomingFiles.set(transferId, {
                                peerId: id,
                                fileName: offer.fileName,
                                fileType: offer.fileType,
                                size: offer.size,
                                totalChunks: Math.max(1, data.totalChunks || 1),
                                chunks: [],
                                received: 0,
                                bytes: 0
                            })
                            upsertTransfer({ id: transferId, direction: 'receive', status: 'active' })
                            reply({ dataType: DataType.ACCEPT, transferId })
                        })
                        return
                    }
                    case DataType.CHUNK: {
                        const inc = transferId ? incomingFiles.get(transferId) : undefined
                        if (!inc || inc.peerId !== id || typeof data.index !== 'number' || !data.chunk) return
                        if (!inc.chunks[data.index]) {
                            inc.chunks[data.index] = data.chunk
                            inc.received++
                            inc.bytes += data.chunk.byteLength
                        }
                        upsertTransfer({ id: transferId as string, direction: 'receive', done: Math.min(inc.size, inc.bytes) })
                        reply({ dataType: DataType.CHUNK_ACK, transferId, received: inc.received })
                        if (inc.received >= inc.totalChunks) {
                            incomingFiles.delete(transferId as string)
                            const file = new Blob(inc.chunks, { type: inc.fileType })
                            upsertTransfer({ id: transferId as string, direction: 'receive', done: inc.size, status: 'done' })
                            console.log("Receiving data from " + id)
                            callback({ dataType: DataType.FILE, file, fileName: inc.fileName, fileType: inc.fileType })
                            reply({ dataType: DataType.ACK, transferId })
                        }
                        return
                    }
                    case DataType.FILE: {
                        // 分割しない古い版からの一括の送信。中身は届いているので受け取りの知らせは返し、保存の前に確かめる
                        if (transferId) reply({ dataType: DataType.ACK, transferId })
                        offerHandler({
                            peerId: id,
                            transferId: transferId || newTransferId(),
                            fileName: data.fileName || 'file',
                            fileType: data.fileType || '',
                            size: data.file ? data.file.size : 0,
                            timeoutMs: OFFER_TIMEOUT_MS
                        }).catch(() => false).then((accepted) => {
                            if (accepted) {
                                console.log("Receiving data from " + id)
                                callback(data)
                            }
                        })
                        return
                    }
                    default:
                        console.log("Receiving data from " + id)
                        callback(data)
                }
            })
        }
    }

}