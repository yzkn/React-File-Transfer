import Peer, { DataConnection, PeerErrorType, PeerError } from "peerjs";
import { message } from "antd";

export enum DataType {
    FILE = 'FILE',
    OTHER = 'OTHER'
}

export interface Data {
    dataType: DataType
    file?: Blob
    fileName?: string
    fileType?: string
    message?: string
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
let keepAliveTimer: ReturnType<typeof setTimeout> | undefined
let connectionMap: Map<string, DataConnection> = new Map<string, DataConnection>()

export const PeerConnection = {
    getPeer: () => peer,
    startPeerSession: () => new Promise<string>((resolve, reject) => {
        try {
            peer = new Peer(PEERJS_ID)
            peer.on('open', (id) => {
                console.log('My ID: ' + id)
                resolve(id)
            }).on('error', (err) => {
                console.log(err)
                message.error(err.message)
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
    // timeoutMs を渡すと、その時間で開かなければ閉じて失敗にする（相手がいないのにサーバーから応答が無いことがある）
    connectPeer: (id: string, timeoutMs?: number) => new Promise<void>((resolve, reject) => {
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
                const timer = timeoutMs ? setTimeout(() => {
                    peer?.removeListener('error', handlePeerError)
                    conn.close()
                    reject(new Error("Connection timed out: " + id))
                }, timeoutMs) : undefined
                conn.on('open', function () {
                    clearTimeout(timer)
                    console.log("Connect to: " + id)
                    connectionMap.set(id, conn)
                    peer?.removeListener('error', handlePeerError)
                    resolve()
                }).on('error', function (err) {
                    clearTimeout(timer)
                    console.log(err)
                    peer?.removeListener('error', handlePeerError)
                    reject(err)
                })

                // When the connection fails due to expiry, the error gets emmitted
                // to the peer instead of to the connection.
                // We need to handle this here to be able to fulfill the Promise.
                const handlePeerError = (err: PeerError<`${PeerErrorType}`>) => {
                    if (err.type === 'peer-unavailable') {
                        const messageSplit = err.message.split(' ')
                        const peerId = messageSplit[messageSplit.length - 1]
                        if (id === peerId) {
                            clearTimeout(timer)
                            peer?.removeListener('error', handlePeerError)
                            reject(err)
                        }
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
            connectionMap.set(conn.peer, conn)
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
    sendConnection: (id: string, data: Data): Promise<void> => new Promise((resolve, reject) => {
        if (!connectionMap.has(id)) {
            reject(new Error("Connection didn't exist"))
        }
        try {
            let conn = connectionMap.get(id);
            if (conn) {
                conn.send(data)
            }
        } catch (err) {
            reject(err)
        }
        resolve()
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
                console.log("Receiving data from " + id)
                let data = receivedData as Data
                callback(data)
            })
        }
    },
    isConnected: (id: string) => connectionMap.has(id),
    // シグナリングのサーバーから切れたら（スマートフォンが裏に回ったときなど）、間隔を延ばしながら取り直す。
    // 画面が前に戻ったとき・ネットワークが戻ったときにも、すぐに試す。相手との直接の接続は、これとは別に保たれる
    keepAlive: (onReconnected?: () => void) => {
        const p = peer
        if (!p) {
            throw new Error("Peer doesn't start yet")
        }
        let retry = 0
        const tryReconnect = () => {
            if (keepAliveTimer) {
                clearTimeout(keepAliveTimer)
                keepAliveTimer = undefined
            }
            if (p !== peer || p.destroyed || !p.disconnected) return
            console.log('Reconnecting to the signaling server')
            p.reconnect()
            retry++
            keepAliveTimer = setTimeout(tryReconnect, Math.min(1000 * 2 ** retry, 30000))
        }
        p.on('disconnected', () => {
            console.log('Disconnected from the signaling server')
            if (!keepAliveTimer) {
                keepAliveTimer = setTimeout(tryReconnect, 1000)
            }
        })
        p.on('open', () => {
            if (retry > 0) {
                retry = 0
                if (keepAliveTimer) {
                    clearTimeout(keepAliveTimer)
                    keepAliveTimer = undefined
                }
                onReconnected?.()
            }
        })
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') tryReconnect()
        })
        window.addEventListener('online', tryReconnect)
    }
}
