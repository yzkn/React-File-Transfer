import React, { useEffect, useState } from "react";
import { Button, Card, Col, Input, List, Menu, MenuProps, message, Modal, Progress, Row, Space, Typography, Upload, UploadFile } from "antd";
import { CopyOutlined, DeleteOutlined, ExportOutlined, InboxOutlined, SendOutlined } from "@ant-design/icons";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import { startPeer } from "./store/peer/peerActions";
import * as connectionAction from "./store/connection/connectionActions"
import { DataType, DECLINED_ERROR, FileOffer, NO_RESPONSE_ERROR, PeerConnection } from "./helpers/peer";
import { useAsyncState } from "./helpers/hooks";
import { clearReceivedTexts, removeReceivedText, toOpenableUrl, useReceivedTexts } from "./helpers/textMessages";
import { clearFinishedTransfers, formatSize, Transfer, useTransfers } from "./helpers/transfers";

import { QRCodeSVG } from 'qrcode.react';
import queryString from 'query-string';

type MenuItem = Required<MenuProps>['items'][number]

// 共有メニュー（service-worker.ts の share-target）から渡されたファイルを取り出す
const SHARE_CACHE = 'share-target'
const loadSharedFiles = async (): Promise<UploadFile[]> => {
    if (!('caches' in window)) return []
    const cache = await caches.open(SHARE_CACHE)
    const keys = [...await cache.keys()]
    const index = (r: Request) => Number(r.url.split('/').pop())
    keys.sort((a, b) => index(a) - index(b))
    const files: UploadFile[] = []
    for (const key of keys) {
        const res = await cache.match(key)
        if (!res) continue
        // Cache の中身は消すと読めなくなるので、先にメモリーに読み切る
        const data = await res.arrayBuffer()
        const name = decodeURIComponent(res.headers.get('X-File-Name') || 'shared')
        const file = new File([data], name, { type: res.headers.get('Content-Type') || '' })
        files.push(Object.assign(file, { uid: 'shared-' + key.url }) as unknown as UploadFile)
        await cache.delete(key)
    }
    return files
}

function getItem(
    label: React.ReactNode,
    key: React.Key,
    icon?: React.ReactNode,
    children?: MenuItem[],
    type?: 'group',
): MenuItem {
    return {
        key,
        icon,
        children,
        label,
        type,
    } as MenuItem;
}

const MAX_FILES = 10

// 受け取る前の確認。時間切れ（送り手があきらめる時間）で、断ったことにして閉じる
const confirmOffer = (offer: FileOffer) => new Promise<boolean>((resolve) => {
    let settled = false
    const settle = (accepted: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(accepted)
    }
    const modal = Modal.confirm({
        title: "ファイルを受け取りますか",
        content: offer.peerId + " から「" + offer.fileName + "」（" + formatSize(offer.size) + "）",
        okText: "受け取る",
        cancelText: "断る",
        onOk: () => settle(true),
        onCancel: () => settle(false),
    })
    const timer = setTimeout(() => {
        modal.destroy()
        settle(false)
    }, offer.timeoutMs)
})

const transferStatusText = (t: Transfer) => {
    switch (t.status) {
        case 'waiting': return t.direction === 'send' ? "相手の確認待ち" : "確認待ち"
        case 'active': return t.direction === 'send' ? "送信中" : "受信中"
        case 'done': return t.direction === 'send' ? "相手が受け取りました" : "受け取りました"
        case 'declined': return t.direction === 'send' ? "相手が断りました" : "断りました"
        case 'failed': return "失敗しました"
    }
}

const TransferRow: React.FC<{ t: Transfer }> = ({ t }) => {
    const percent = t.size > 0 ? Math.floor(t.done * 100 / t.size) : (t.status === 'done' ? 100 : 0)
    const status = t.status === 'done' ? 'success'
        : (t.status === 'failed' || t.status === 'declined') ? 'exception'
            : t.status === 'active' ? 'active' : 'normal'
    return (
        <div className="transfer-row" data-transfer-direction={t.direction} data-transfer-status={t.status}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ wordBreak: 'break-all' }}>
                    {t.direction === 'send' ? "送信 → " : "受信 ← "}{t.peerId}: {t.fileName}
                </span>
                <span>{transferStatusText(t)}（{formatSize(t.done)} / {formatSize(t.size)}）</span>
            </div>
            <Progress percent={percent} status={status} size="small" />
        </div>
    )
}

export const App: React.FC = () => {

    const peer = useAppSelector((state) => state.peer)
    const connection = useAppSelector((state) => state.connection)
    const dispatch = useAppDispatch()

    const handleConnectOtherPeer = () => {
        connection.id != null ? dispatch(connectionAction.connectPeer(connection.id || "")) : message.warning("相手の ID を入力してください")
    }

    const [fileList, setFileList] = useAsyncState([] as UploadFile[])
    const [sendLoading, setSendLoading] = useAsyncState(false)

    // 送信できない理由（ボタンを押せなくし、下に添える）
    const hasTarget = !!connection.selectedId && connection.selectedIds.length > 0
    const sendBlockedReason = fileList.length === 0
        ? 'ファイルを選んでください'
        : !hasTarget
            ? (connection.list.length === 0
                ? '送る相手がいません。「宛先」で相手の ID に接続するか、相手にこの画面の QR を読んでもらってください'
                : '「宛先」で送る相手を選んでください')
            : ''

    // Ctrl+V（貼り付け）でファイルを足す。入力欄への貼り付けはそのまま
    useEffect(() => {
        const onPaste = (e: ClipboardEvent) => {
            const target = e.target as HTMLElement | null
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return
            const files = Array.from(e.clipboardData?.files || [])
            if (files.length === 0) return
            e.preventDefault()
            const added = files.map((f, i) => Object.assign(f, { uid: `paste-${Date.now()}-${i}` }) as unknown as UploadFile)
            const next = [...fileList, ...added].slice(0, MAX_FILES)
            setFileList(next)
            message.info(`${next.length - fileList.length} 件のファイルを貼り付けました`)
        }
        document.addEventListener('paste', onPaste)
        return () => document.removeEventListener('paste', onPaste)
    }, [fileList, setFileList])

    const handleUpload = async () => {
        if (fileList.length === 0) {
            message.warning("ファイルを選んでください")
            return
        }
        if (!connection.selectedId) {
            message.warning("送る相手を選んでください")
            return
        }
        console.log('connection.selectedIds', connection.selectedIds);
        if (connection.selectedIds.length === 0) {
            message.warning("送る相手を選んでください")
            return
        }
        await setSendLoading(true);
        // 1 件が断られた・失敗しても、残りは送る
        let succeeded = 0
        let failed = 0
        for (let i = 0; i < fileList.length; i++) {
            const file = fileList[i] as unknown as File;
            let blob = new Blob([file], { type: file.type });

            for (let j = 0; j < connection.selectedIds.length; j++) {
                const selectedId = connection.selectedIds[j];
                try {
                    await PeerConnection.sendConnection(selectedId, {
                        dataType: DataType.FILE,
                        file: blob,
                        fileName: file.name,
                        fileType: file.type
                    });
                    succeeded++
                } catch (err) {
                    failed++
                    console.log(err)
                    message.error(sendErrorMessage(selectedId, file.name, err))
                }
            }
        }
        await setSendLoading(false)
        // sendConnection は相手からの受け取りの知らせを待つので、成功したものは届いている
        if (succeeded > 0 && failed === 0) {
            message.success("送信しました（相手が受け取りました）")
        } else if (succeeded > 0) {
            message.warning("一部を送信しました（受け取られた " + succeeded + " 件・届かなかった " + failed + " 件）")
        }
    }

    useEffect(() => {
        PeerConnection.setOfferHandler(confirmOffer)
    }, [])

    const transfers = useTransfers()

    const [text, setText] = useState("")
    const [textSending, setTextSending] = useState(false)
    const receivedTexts = useReceivedTexts()

    const handleSendText = async () => {
        if (text.trim() === "") {
            message.warning("送るテキストを入力してください")
            return
        }
        if (connection.selectedIds.length === 0) {
            message.warning("送る相手を選んでください")
            return
        }
        setTextSending(true)
        try {
            for (const selectedId of connection.selectedIds) {
                await PeerConnection.sendConnection(selectedId, {
                    dataType: DataType.OTHER,
                    message: text
                })
            }
            message.info("テキストを送りました")
            setText("")
        } catch (err) {
            console.log(err)
            message.error("テキストを送れませんでした")
        } finally {
            setTextSending(false)
        }
    }

    const [pid, setStr] = useState("");

    const shareUrl = document.location.origin + "?id=" + (peer.id || "");

    const copyText = async (text: string, label: string) => {
        try {
            await navigator.clipboard.writeText(text)
            message.success(label + " をコピーしました")
        } catch (err) {
            console.log(err)
            message.error(label + " をコピーできませんでした")
        }
    }

    const init = async () => {
        const parsed = queryString.parse(window.location.search);

        const pid = (parsed?.id || "") as string;

        if (parsed?.shared != null) {
            window.history.replaceState(null, '', window.location.pathname)
            try {
                const shared = await loadSharedFiles()
                if (shared.length > 0) {
                    await setFileList(shared.slice(0, 10))
                    message.info(`共有された ${shared.length} 件のファイルを追加しました。送る相手を選んで「送信」を押してください`)
                } else {
                    message.warning('共有されたファイルを受け取れませんでした')
                }
            } catch (err) {
                console.log(err)
                message.warning('共有されたファイルを受け取れませんでした')
            }
        }

        if (pid !== "") {
            setStr(pid);
            dispatch(connectionAction.changeConnectionInput(pid));
        }

        // 自分の準備（シグナリングのサーバーへの登録）が終わるのを待ってから接続する
        await dispatch(startPeer());

        if (pid !== "") {
            if (!PeerConnection.getPeer()?.open) {
                message.error("接続できませんでした: こちらの準備ができていません。ページを読み込み直してください");
                return;
            }
            dispatch(connectionAction.connectPeer(pid));
        }
    };

    useEffect(() => {
        if (document.readyState === "complete") {
            init();
        } else {
            window.addEventListener("load", init);
            return () => {
                window.removeEventListener("load", init);
            };
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    return (
        <Row justify={"center"} align={"top"}>
            <Col xs={24} sm={24} md={20} lg={16} xl={12}>
                <Card hidden={pid !== '' || typeof peer.id === "undefined"}>
                    <Row>
                        <Col span={8} offset={8}>
                            <a href={shareUrl}
                                rel="noreferrer"
                                target="_blank"
                                style={{
                                    display: "block",
                                    margin: "64px auto 16px",
                                    textAlign: "center"
                                }}>
                                <QRCodeSVG
                                    value={shareUrl}
                                    title={shareUrl}
                                    className="w-full h-full p-6"
                                    bgColor="#ffffff"
                                    level="H"
                                />
                            </a>
                        </Col>
                    </Row>
                    <div style={{ textAlign: "center" }}>
                        <p>この QR を相手の端末で読み取るか、下の URL を相手に送ると、この端末とつながります</p>
                        <Space direction="horizontal" wrap style={{ justifyContent: "center" }}>
                            <Typography.Text code style={{ wordBreak: "break-all" }}>{shareUrl}</Typography.Text>
                            <Button icon={<CopyOutlined />} aria-label="URL をコピー" onClick={() => copyText(shareUrl, "URL")}>コピー</Button>
                        </Space>
                    </div>
                </Card>
                <Card title="宛先">
                    <Space direction="vertical" style={{ width: "100%" }}>
                        <Space direction="horizontal" wrap>
                            <div title={peer.id}>自分の ID: {peer.id ? peer.id : '準備中…'}</div>
                            <Button icon={<CopyOutlined />} aria-label="自分の ID をコピー" disabled={!peer.id}
                                onClick={() => copyText(peer.id || "", "自分の ID")} />
                        </Space>
                        {
                            connection.list.length === 0
                                ? <div>接続を待っています…（相手がこの端末の QR か URL を開くと、ここに出ます）</div>
                                : <div>
                                    送る相手を選んでください（複数可）
                                    <Menu selectedKeys={connection.selectedIds.length > 0 ? connection.selectedIds : []}
                                        onSelect={(item) => dispatch(connectionAction.selectItem(item.key))}
                                        onDeselect={(item) => dispatch(connectionAction.deselectItem(item.key))}
                                        items={connection.list.map(e => getItem(e, e, null))}
                                        multiple={true} />
                                </div>
                        }
                        <details>
                            <summary>相手の ID を入力してつなぐ</summary>
                            <Space direction="horizontal" size="large" style={{ marginTop: 8 }}>
                                <Input placeholder={"相手の ID"}
                                    onChange={e => { setStr(e.target.value); dispatch(connectionAction.changeConnectionInput(e.target.value)) }}
                                    required={true}
                                    value={pid}
                                />
                                <Button onClick={handleConnectOtherPeer}
                                    loading={connection.loading}>接続</Button>
                            </Space>
                        </details>
                    </Space>
                </Card>
                <Card title="ファイル">
                    <Upload.Dragger fileList={fileList}
                        maxCount={MAX_FILES}
                        multiple={true}
                        onRemove={(file) => setFileList(fileList.filter((f: UploadFile) => f.uid !== file.uid))}
                        beforeUpload={(_, fileList) => {
                            setFileList(fileList)
                            return false
                        }}>
                        <p className="ant-upload-drag-icon"><InboxOutlined /></p>
                        <p className="ant-upload-text">ここにファイルをドロップ、またはクリックして選択</p>
                        <p className="ant-upload-hint">Ctrl+V で貼り付けても追加できます（{MAX_FILES} 件まで）</p>
                    </Upload.Dragger>
                    <Button
                        type="primary"
                        onClick={handleUpload}
                        disabled={sendBlockedReason !== ''}
                        loading={sendLoading}
                        style={{ marginTop: 16 }}
                    >
                        {sendLoading ? '送信中' : '送信'}
                    </Button>
                    {sendBlockedReason !== '' &&
                        <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }} data-testid="send-blocked-reason">
                            {sendBlockedReason}
                        </Typography.Text>}
                </Card>
                <Card title="テキスト・URL">
                    <Input.TextArea
                        aria-label="送るテキスト"
                        placeholder="送るテキストや URL"
                        autoSize={{ minRows: 2, maxRows: 8 }}
                        value={text}
                        onChange={e => setText(e.target.value)}
                    />
                    <Button
                        type="primary"
                        icon={<SendOutlined />}
                        onClick={handleSendText}
                        disabled={text.trim() === ""}
                        loading={textSending}
                        style={{ marginTop: 16 }}
                    >
                        テキストを送信
                    </Button>
                    {
                        receivedTexts.length > 0 &&
                        <List
                            style={{ marginTop: 16 }}
                            header={
                                <Space style={{ width: "100%", justifyContent: "space-between" }}>
                                    <span>受け取ったテキスト</span>
                                    <Button size="small" onClick={clearReceivedTexts}>すべて消す</Button>
                                </Space>
                            }
                            bordered
                            dataSource={receivedTexts}
                            renderItem={(item) => {
                                const url = toOpenableUrl(item.text)
                                return (
                                    <List.Item
                                        actions={[
                                            <Button key="copy" size="small" icon={<CopyOutlined />} onClick={() => copyText(item.text, "テキスト")}>コピー</Button>,
                                            ...(url ? [<Button key="open" size="small" icon={<ExportOutlined />} href={url} target="_blank" rel="noopener noreferrer">開く</Button>] : []),
                                            <Button key="delete" size="small" icon={<DeleteOutlined />} aria-label="消す" onClick={() => removeReceivedText(item.key)} />
                                        ]}
                                    >
                                        <List.Item.Meta
                                            description={item.from + " から・" + item.receivedAt.toLocaleTimeString()}
                                            title={
                                                <Typography.Paragraph style={{ whiteSpace: "pre-wrap", wordBreak: "break-all", marginBottom: 0 }}>
                                                    {item.text}
                                                </Typography.Paragraph>
                                            }
                                        />
                                    </List.Item>
                                )
                            }}
                        />
                    }
                </Card>
                {transfers.length > 0 &&
                    <Card title="送受信の状況"
                        extra={<Button size="small" onClick={clearFinishedTransfers}>終わったものを消す</Button>}>
                        <Space direction="vertical" style={{ width: '100%' }}>
                            {transfers.map(t => <TransferRow key={t.direction + t.id} t={t} />)}
                        </Space>
                    </Card>
                }
            </Col>
        </Row>
    )
}

// 送信の失敗を、利用者に分かる言葉にする
const sendErrorMessage = (peerId: string, fileName: string, err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err)
    if (detail === DECLINED_ERROR) {
        return "「" + fileName + "」: 相手（" + peerId + "）が受け取りを断りました"
    }
    if (detail === NO_RESPONSE_ERROR) {
        return "「" + fileName + "」: 相手（" + peerId + "）が受け取るかどうかを決めませんでした"
    }
    if (detail.startsWith("No acknowledgement")) {
        return "「" + fileName + "」: 送信できたか分かりません。相手（" + peerId + "）から受け取りの知らせが届きませんでした"
    }
    return "「" + fileName + "」を送信できませんでした: " + detail
}

export default App
