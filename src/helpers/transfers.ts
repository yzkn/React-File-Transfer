import { useSyncExternalStore } from "react";

// 送受信の進み具合（ファイルごと）。peer.ts が書き、画面が読む

export type TransferDirection = 'send' | 'receive'
export type TransferStatus = 'waiting' | 'active' | 'done' | 'declined' | 'failed'

export interface Transfer {
    id: string
    peerId: string
    direction: TransferDirection
    fileName: string
    size: number
    // 相手に届いた（受け手は受け取った）バイト数
    done: number
    status: TransferStatus
    error?: string
}

let transfers: Transfer[] = []
const listeners = new Set<() => void>()

const emit = () => listeners.forEach((l) => l())

export const upsertTransfer = (t: Partial<Transfer> & { id: string }) => {
    const i = transfers.findIndex((e) => e.id === t.id && (!t.direction || e.direction === t.direction))
    if (i < 0) {
        transfers = [...transfers, {
            peerId: '', direction: 'send', fileName: '', size: 0, done: 0, status: 'waiting', ...t
        }]
    } else {
        transfers = transfers.map((e, j) => (j === i ? { ...e, ...t } : e))
    }
    emit()
}

// 終わったもの（完了・断られた・失敗）を一覧から消す
export const clearFinishedTransfers = () => {
    transfers = transfers.filter((t) => t.status === 'waiting' || t.status === 'active')
    emit()
}

const subscribe = (l: () => void) => {
    listeners.add(l)
    return () => { listeners.delete(l) }
}

export const getTransfers = () => transfers

export const useTransfers = () => useSyncExternalStore(subscribe, getTransfers)

export const formatSize = (bytes: number) => {
    if (bytes < 1024) return bytes + ' B'
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
    if (bytes < 1024 * 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + ' MB'
    return (bytes / 1024 / 1024 / 1024).toFixed(2) + ' GB'
}
