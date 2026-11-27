import { PeerActionType } from "./peerTypes";
import { Dispatch } from "redux";
import { DataType, PeerConnection } from "../../helpers/peer";
import { message } from "antd";
import { addConnectionList, removeConnectionList } from "../connection/connectionActions";
import download from "js-file-download";
import { handleReceivedText } from "../../helpers/textMessages";

export const startPeerSession = (id: string) => ({
    type: PeerActionType.PEER_SESSION_START, id
})

export const stopPeerSession = () => ({
    type: PeerActionType.PEER_SESSION_STOP,
})
export const setLoading = (loading: boolean) => ({
    type: PeerActionType.PEER_LOADING, loading
})

export const startPeer: () => (dispatch: Dispatch) => Promise<void>
    = () => (async (dispatch) => {
        dispatch(setLoading(true))
        try {
            const id = await PeerConnection.startPeerSession()
            PeerConnection.onIncomingConnection((conn) => {
                const peerId = conn.peer
                message.info("接続されました: " + peerId)
                dispatch(addConnectionList(peerId))
                PeerConnection.onConnectionDisconnected(peerId, () => {
                    message.info("接続が切れました: " + peerId)
                    dispatch(removeConnectionList(peerId))
                })
                PeerConnection.onConnectionReceiveData(peerId, (file) => {
                    if (handleReceivedText(peerId, file)) return
                    message.info(peerId + " からファイル「" + file.fileName + "」を受け取っています")
                    if (file.dataType === DataType.FILE) {
                        download(file.file || '', file.fileName || "fileName", file.fileType)
                    }
                })
            })
            dispatch(startPeerSession(id))
            dispatch(setLoading(false))
        } catch (err) {
            console.log(err)
            dispatch(setLoading(false))
        }
    })


