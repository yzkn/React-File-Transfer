import React, { useEffect, useState } from "react";
import { Button, Card, Col, Input, Menu, MenuProps, message, Row, Space, Upload, UploadFile } from "antd";
import { CopyOutlined, UploadOutlined } from "@ant-design/icons";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import { startPeer } from "./store/peer/peerActions";
import * as connectionAction from "./store/connection/connectionActions"
import { DataType, PeerConnection } from "./helpers/peer";
import { useAsyncState } from "./helpers/hooks";

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
                <Card hidden={!peer.started && pid !== ''}>
                    <Row>
                        <Col span={8} offset={8}>
                            <a href={document.location.href + "?id=" + peer.id || ""}
                                rel="noreferrer"
                                target="_blank"
                                style={{
                                    display: "block",
                                    margin: "64px auto",
                                    textAlign: "center"
                                }}>
                                <QRCodeSVG
                                    value={document.location.href + "?id=" + peer.id || ""}
                                    title={document.location.href + "?id=" + peer.id || ""}
                                    className="w-full h-full p-6"
                                    bgColor="#ffffff"
                                    level="H"
                                />
                            </a>
                        </Col>
                    </Row>
                </Card>
                <div hidden={!peer.started}>
                    <Card>
                        <details>
                            <summary>宛先</summary>
                            <Space direction="horizontal" size="large">
                                <Space direction="vertical">
                                    <Space direction="horizontal">
                                        <div title={peer.id}>My ID: {peer.id ? '...' + peer.id.slice(-8) : ''}</div>
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
                                                items={connection.list.map(e => getItem('...' + e.slice(-8), e, null))}
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
                            {sendLoading ? 'Sending' : 'Send'}
                        </Button>
                    </Card>
                </div>
            </Col>
        </Row>
    )
}

export default App
