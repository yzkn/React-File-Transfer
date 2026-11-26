import React, { useEffect, useState } from "react";
import { Button, Card, Col, Input, List, Menu, MenuProps, message, Row, Space, Typography, Upload, UploadFile } from "antd";
import { CopyOutlined, DeleteOutlined, ExportOutlined, SendOutlined, UploadOutlined } from "@ant-design/icons";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import { startPeer } from "./store/peer/peerActions";
import * as connectionAction from "./store/connection/connectionActions"
import { DataType, PeerConnection } from "./helpers/peer";
import { useAsyncState } from "./helpers/hooks";
import { clearReceivedTexts, removeReceivedText, toOpenableUrl, useReceivedTexts } from "./helpers/textMessages";

import { QRCodeSVG } from 'qrcode.react';
import queryString from 'query-string';

type MenuItem = Required<MenuProps>['items'][number]

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

export const App: React.FC = () => {

    const peer = useAppSelector((state) => state.peer)
    const connection = useAppSelector((state) => state.connection)
    const dispatch = useAppDispatch()

    const handleStartSession = () => {
        dispatch(startPeer())
    }

    const handleConnectOtherPeer = () => {
        connection.id != null ? dispatch(connectionAction.connectPeer(connection.id || "")) : message.warning("Please enter ID")
    }

    const [fileList, setFileList] = useAsyncState([] as UploadFile[])
    const [sendLoading, setSendLoading] = useAsyncState(false)

    const handleUpload = async () => {
        if (fileList.length === 0) {
            message.warning("Please select file")
            return
        }
        if (!connection.selectedId) {
            message.warning("Please select a connection")
            return
        }
        console.log('connection.selectedIds', connection.selectedIds);
        if (connection.selectedIds.length === 0) {
            message.warning("Please select a connection")
            return
        }
        try {
            await setSendLoading(true);

            for (let i = 0; i < fileList.length; i++) {
                const file = fileList[i] as unknown as File;
                let blob = new Blob([file], { type: file.type });

                for (let j = 0; j < connection.selectedIds.length; j++) {
                    const selectedId = connection.selectedIds[j];
                    await PeerConnection.sendConnection(selectedId, {
                        dataType: DataType.FILE,
                        file: blob,
                        fileName: file.name,
                        fileType: file.type
                    });
                }
            }

            await setSendLoading(false)
            message.info("Send file successfully")
        } catch (err) {
            await setSendLoading(false)
            console.log(err)
            message.error("Error when sending file")
        }
    }

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

    const copyText = async (value: string) => {
        try {
            await navigator.clipboard.writeText(value)
            message.info("コピーしました")
        } catch (err) {
            console.log(err)
            message.error("コピーできませんでした")
        }
    }

    const [pid, setStr] = useState("");

    const init = async () => {
        const parsed = queryString.parse(window.location.search);

        const pid = (parsed?.id || "") as string;
        handleStartSession();

        if (pid !== "") {
            setStr(pid);
            dispatch(connectionAction.changeConnectionInput(pid));

            await new Promise((resolve) => setTimeout(resolve, 2000));

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
                            <a href={document.location.origin + "?id=" + peer.id || ""}
                                rel="noreferrer"
                                target="_blank"
                                style={{
                                    display: "block",
                                    margin: "64px auto",
                                    textAlign: "center"
                                }}>
                                <QRCodeSVG
                                    value={document.location.origin + "?id=" + peer.id || ""}
                                    title={document.location.origin + "?id=" + peer.id || ""}
                                    className="w-full h-full p-6"
                                    bgColor="#ffffff"
                                    level="H"
                                />
                            </a>
                        </Col>
                    </Row>
                </Card>
                <Card>
                    <details>
                        <summary>宛先</summary>
                        <Space direction="horizontal" size="large">
                            <Space direction="vertical">
                                <Space direction="horizontal">
                                    <div title={peer.id}>My ID: {peer.id ? peer.id : ''}</div>
                                    <Button icon={<CopyOutlined />} onClick={async () => {
                                        await navigator.clipboard.writeText(peer.id || "")
                                        message.info("Copied: " + peer.id)
                                    }} />
                                </Space>
                                <Space direction="horizontal" size="large">
                                    <Input placeholder={"ID"}
                                        onChange={e => { setStr(e.target.value); dispatch(connectionAction.changeConnectionInput(e.target.value)) }}
                                        required={true}
                                        value={pid}
                                    />
                                    <Button onClick={handleConnectOtherPeer}
                                        loading={connection.loading}>接続</Button>
                                </Space>
                            </Space>
                            {
                                connection.list.length === 0
                                    ? <div>Waiting for connection ...</div>
                                    : <div>
                                        Select a connection(s)
                                        <Menu selectedKeys={connection.selectedIds.length > 0 ? connection.selectedIds : []}
                                            onSelect={(item) => dispatch(connectionAction.selectItem(item.key))}
                                            onDeselect={(item) => dispatch(connectionAction.deselectItem(item.key))}
                                            items={connection.list.map(e => getItem(e, e, null))}
                                            multiple={true} />
                                    </div>
                            }
                        </Space>
                    </details>
                </Card>
                <Card title="ファイル">
                    <Upload fileList={fileList}
                        maxCount={10}
                        multiple={true}
                        onRemove={() => setFileList([])}
                        beforeUpload={(_, fileList) => {
                            setFileList(fileList)
                            return false
                        }}>
                        <Button icon={<UploadOutlined />}>選択</Button>
                    </Upload>
                    <Button
                        type="primary"
                        onClick={handleUpload}
                        disabled={fileList.length === 0}
                        loading={sendLoading}
                        style={{ marginTop: 16 }}
                    >
                        {sendLoading ? '送信中' : '送信'}
                    </Button>
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
                                            <Button key="copy" size="small" icon={<CopyOutlined />} onClick={() => copyText(item.text)}>コピー</Button>,
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
            </Col>
        </Row>
    )
}

export default App
