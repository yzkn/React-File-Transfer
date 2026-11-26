import Peer, { DataConnection, PeerErrorType, PeerError } from "peerjs";
import { message } from "antd";

export enum DataType {
    FILE = 'FILE',
    OTHER = 'OTHER',
    // 受け手が FILE を受け取ったことを送り手に知らせる
    ACK = 'ACK'
}

export interface Data {
    dataType: DataType
    file?: Blob
    fileName?: string
    fileType?: string
    message?: string
    // 送り手が付ける転送ごとの ID。受け手は同じ ID で ACK を返す
    transferId?: string
}

// 接続の時間切れ（相手が応答しないとき）
const CONNECT_TIMEOUT_MS = 15000
// 受け取りの知らせ（ACK）を待つ時間: 基本の時間 + 大きさに応じた時間（約 50KB/秒 を下限の速さとみる）
const ACK_TIMEOUT_BASE_MS = 60000
const ACK_BYTES_PER_MS = 50

const newTransferId = () => Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)

interface PendingAck {
    peerId: string
    resolve: () => void
    reject: (err: Error) => void
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

let peer: Peer | undefined
let connectionMap: Map<string, DataConnection> = new Map<string, DataConnection>()
let pendingAcks: Map<string, PendingAck> = new Map<string, PendingAck>()

// その相手への送信で、受け取りの知らせを待っているものをすべて失敗にする
const rejectPendingAcks = (peerId: string, err: Error) => {
    Array.from(pendingAcks.entries()).forEach(([transferId, pending]) => {
        if (pending.peerId === peerId) {
            pendingAcks.delete(transferId)
            pending.reject(err)
        }
    })
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
        try {
            let opened = false
            peer = new Peer(PEERJS_ID)
            peer.on('open', (id) => {
                console.log('My ID: ' + id)
                opened = true
                resolve(id)
            }).on('error', (err) => {
                console.log(err)
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
    // 相手から受け取りの知らせ（ACK）が届いたら resolve する（送り出しただけでは resolve しない）
    sendConnection: (id: string, data: Data): Promise<void> => new Promise((resolve, reject) => {
        const conn = connectionMap.get(id)
        if (!conn || !conn.open) {
            reject(new Error("Connection didn't exist: " + id))
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
            conn.on('data', function (receivedData) {
                let data = receivedData as Data
                if (data.dataType === DataType.ACK) {
                    // こちらから送ったものを、相手が受け取った
                    const pending = data.transferId ? pendingAcks.get(data.transferId) : undefined
                    if (pending && pending.peerId === id) {
                        pendingAcks.delete(data.transferId as string)
                        pending.resolve()
                    }
                    return
                }
                console.log("Receiving data from " + id)
                callback(data)
                if (data.dataType === DataType.FILE && data.transferId) {
                    try {
                        conn?.send({ dataType: DataType.ACK, transferId: data.transferId })
                    } catch (err) {
                        console.log(err)
                    }
                }
            })
        }
    }

}