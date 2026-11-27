import React, { useEffect, useState } from 'react';
import { ConfigProvider, theme } from 'antd';
import ReactDOM from 'react-dom/client';
import App from './App';
import * as serviceWorkerRegistration from './serviceWorkerRegistration';
import reportWebVitals from './reportWebVitals';
import { store } from "./store";
import { Provider } from "react-redux";

const root = ReactDOM.createRoot(
    document.getElementById('root') as HTMLElement
);
// OS の外観（ライト・ダーク）に合わせる。切り替えにも追従する
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

const themeConfig = (dark: boolean) => ({ algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm })

const applyTheme = (dark: boolean) => {
    const token = theme.getDesignToken(themeConfig(dark))
    // ライトのときは従来どおり（ブラウザーの既定の白）
    document.body.style.backgroundColor = dark ? token.colorBgLayout : ''
    document.body.style.color = dark ? token.colorText : ''
    document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#000000' : '#ffffff')
    // message.info などの静的な呼び出しにも同じテーマを当てる
    ConfigProvider.config({
        holderRender: (children) => <ConfigProvider theme={themeConfig(dark)}>{children}</ConfigProvider>
    })
}

const ThemeRoot: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const [dark, setDark] = useState(darkQuery.matches)
    useEffect(() => {
        const onChange = (e: MediaQueryListEvent) => setDark(e.matches)
        darkQuery.addEventListener('change', onChange)
        return () => darkQuery.removeEventListener('change', onChange)
    }, [])
    useEffect(() => applyTheme(dark), [dark])
    return <ConfigProvider theme={themeConfig(dark)}>{children}</ConfigProvider>
}

root.render(
    <Provider store={store}>
        <ThemeRoot>
            <App />
        </ThemeRoot>
    </Provider>
);

// If you want your app to work offline and load faster, you can change
// unregister() to register() below. Note this comes with some pitfalls.
// Learn more about service workers: https://cra.link/PWA
serviceWorkerRegistration.register();

// If you want to start measuring performance in your app, pass a function
// to log results (for example: reportWebVitals(console.log))
// or send to an analytics endpoint. Learn more: https://bit.ly/CRA-vitals
reportWebVitals();
