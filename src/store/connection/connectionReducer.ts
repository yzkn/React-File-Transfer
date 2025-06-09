import { Reducer } from "redux";
import { ConnectionActionType, ConnectionState } from "./connectionTypes";

export const initialState: ConnectionState = {
    id: undefined,
    loading: false,
    list: [],
    selectedId: undefined,
    selectedIds: []
}

export const ConnectionReducer: Reducer<ConnectionState> = (state = initialState, action) => {
    if (action.type === ConnectionActionType.CONNECTION_INPUT_CHANGE) {
        const { id } = action
        return { ...state, id }
    } else if (action.type === ConnectionActionType.CONNECTION_CONNECT_LOADING) {
        const { loading } = action
        return { ...state, loading }
    } else if (action.type === ConnectionActionType.CONNECTION_LIST_ADD) {
        let newList = [...state.list, action.id]
        if (newList.length === 1) {
            return { ...state, list: newList, selectedId: action.id, selectedIds: [action.id] }
        }
        return { ...state, list: [...state.list, action.id] }
    } else if (action.type === ConnectionActionType.CONNECTION_LIST_REMOVE) {
        let newList = [...state.list].filter(e => e !== action.id)
        let newIds = [...state.selectedIds].filter(e => e !== action.id)
        if (state.selectedId && !newList.includes(state.selectedId)) {
            if (newList.length === 0) {
                return { ...state, list: newList, selectedId: undefined, selectedIds: [] }
            } else {
                return { ...state, list: newList, selectedId: newIds[0], selectedIds: newIds }
            }
        }
        return { ...state, list: newList, selectedIds: newIds }
    } else if (action.type === ConnectionActionType.CONNECTION_ITEM_SELECT) {
        return { ...state, selectedId: action.id, selectedIds: [...state.selectedIds, action.id] }
    } else if (action.type === ConnectionActionType.CONNECTION_ITEM_DESELECT) {
        let newIds = [...state.selectedIds].filter(e => e !== action.id)
        return { ...state, selectedIds: newIds }
    } else {
        return state
    }
}