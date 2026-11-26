import { ConnectionActionType } from "./connectionTypes";
import { Dispatch } from "redux";
import { DataType, PeerConnection } from "../../helpers/peer";
import { message } from "antd";
import download from "js-file-download";

export const changeConnectionInput = (id: string) => ({
    type: ConnectionActionType.CONNECTION_INPUT_CHANGE, id
})

export const setLoading = (loading: boolean) => ({
    type: ConnectionActionType.CONNECTION_CONNECT_LOADING, loading
})
export const addConnectionList = (id: string) => ({
    type: ConnectionActionType.CONNECTION_LIST_ADD, id
})

export const removeConnectionList = (id: string) => ({
    type: ConnectionActionType.CONNECTION_LIST_REMOVE, id
})

export const deselectItem = (id: string) => ({
    type: ConnectionActionType.CONNECTION_ITEM_DESELECT, id
})

export const selectItem = (id: string) => ({
    type: ConnectionActionType.CONNECTION_ITEM_SELECT, id
})

export const connectPeer: (id: string) => (dispatch: Dispatch) => Promise<void>
    = (id: string) => (async (dispatch) => {
        dispatch(setLoading(true))
        try {
            await PeerConnection.connectPeer(id)
            PeerConnection.onConnectionDisconnected(id, () => {
                message.info("接続が切れました: " + id)
                dispatch(removeConnectionList(id))
            })
            PeerConnection.onConnectionReceiveData(id, (file) => {
                message.info(id + " からファイル「" + file.fileName + "」を受け取っています")
                if (file.dataType === DataType.FILE) {
                    download(file.file || '', file.fileName || "fileName", file.fileType)
                }
            })
            dispatch(addConnectionList(id))
            dispatch(setLoading(false))
        } catch (err) {
            dispatch(setLoading(false))
            console.log(err)
            message.error(connectErrorMessage(id, err))
        }
    })

// 接続の失敗を、利用者に分かる言葉にする
const connectErrorMessage = (id: string, err: unknown) => {
    const e = err as { type?: string, message?: string }
    const detail = e && e.message ? e.message : String(err)
    if (e && e.type === 'peer-unavailable') {
        return "接続できませんでした: 相手（" + id + "）が見つかりません。ID を確かめてください"
    }
    if (detail.startsWith("Connection timed out")) {
        return "接続できませんでした: 相手（" + id + "）から応答がありません"
    }
    if (detail.startsWith("Peer doesn't start yet")) {
        return "接続できませんでした: こちらの準備ができていません。しばらくしてからもう一度試してください"
    }
    if (detail.startsWith("Connection existed")) {
        return "すでに接続しています（" + id + "）"
    }
    return "接続できませんでした（" + id + "）: " + detail
}
