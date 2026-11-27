import { useSyncExternalStore } from "react";
import { message } from "antd";
import { Data, DataType } from "./peer";

// 相手から受け取ったテキスト・URL（F1）。ページを開いている間だけ持つ
export interface ReceivedText {
    key: string
    from: string
    text: string
    receivedAt: Date
}

const MAX_ITEMS = 50

let items: ReceivedText[] = []
let seq = 0
const listeners = new Set<() => void>()

const emit = () => listeners.forEach((l) => l())

export const addReceivedText = (from: string, text: string) => {
    seq += 1
    items = [{ key: `${Date.now()}-${seq}`, from, text, receivedAt: new Date() }, ...items].slice(0, MAX_ITEMS)
    emit()
}

export const removeReceivedText = (key: string) => {
    items = items.filter((e) => e.key !== key)
    emit()
}

export const clearReceivedTexts = () => {
    items = []
    emit()
}

const subscribe = (listener: () => void) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
}

export const useReceivedTexts = () => useSyncExternalStore(subscribe, () => items)

// 受け取ったデータがテキストなら一覧に足して true を返す（ファイルなどは false）
export const handleReceivedText = (from: string, data: Data): boolean => {
    if (data.dataType !== DataType.OTHER || typeof data.message !== "string") {
        return false
    }
    addReceivedText(from, data.message)
    message.info(from + " からテキストを受け取りました")
    return true
}

// http / https の URL だけを「開く」の対象にする（javascript: などはリンクにしない）
export const toOpenableUrl = (text: string): string | undefined => {
    const t = text.trim()
    if (/\s/.test(t)) {
        return undefined
    }
    try {
        const u = new URL(t)
        return u.protocol === "http:" || u.protocol === "https:" ? u.href : undefined
    } catch {
        return undefined
    }
}
