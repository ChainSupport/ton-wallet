const code = `
// https://github.com/ethereum/EIPs/blob/master/EIPS/eip-1193.md#sample-class-implementation
class TonProvider {
    constructor() {
        this.listeners = {};

        this.isTonWallet = true;
        this.targetOrigin = '*'; // todo

        // Init storage
        this._nextJsonRpcId = 0;
        this._promises = {};

        // Fire the connect
        this._connect();

        // Listen for jsonrpc responses
        window.addEventListener('message', this._handleJsonRpcMessage.bind(this));
    }

    /* EventEmitter */

    on(method, listener) {
        let methodListeners = this.listeners[method];
        if (!methodListeners) {
            methodListeners = [];
            this.listeners[method] = methodListeners;
        }
        if (methodListeners.indexOf(listener) === -1) {
            methodListeners.push(listener);
        }
        return this;
    }

    removeListener(method, listener) {
        const methodListeners = this.listeners[method];
        if (!methodListeners) return;
        const index = methodListeners.indexOf(listener);
        if (index > -1) {
            methodListeners.splice(index, 1);
        }
    }

    emit(method, ...args) {
        const methodListeners = this.listeners[method];
        if (!methodListeners || !methodListeners.length) return false;
        methodListeners.forEach(listener => listener(...args));
        return true;
    }

    /* Methods */

    send(method, params = []) {
        if (!method || typeof method !== 'string') {
            return new Error('Method is not a valid string.');
        }

        if (!(params instanceof Array)) {
            return new Error('Params is not a valid array.');
        }

        const id = this._nextJsonRpcId++;
        const jsonrpc = '2.0';
        const payload = {
            jsonrpc,
            id,
            method,
            params,
        };

        const promise = new Promise((resolve, reject) => {
            this._promises[payload.id] = {
                resolve,
                reject,
            };
        });

        // Send jsonrpc request to TON Wallet
        window.postMessage(
            {
                type: 'gramWalletAPI_ton_provider_write',
                message: payload,
            },
            this.targetOrigin,
        );

        return promise;
    }

    /* Internal methods */

    async _handleJsonRpcMessage(event) {
        // Return if no data to parse
        if (!event || !event.data) {
            return;
        }

        let data;
        try {
            data = JSON.parse(event.data);
        } catch (error) {
            // Return if we can't parse a valid object
            return;
        }

        if (data.type !== 'gramWalletAPI') return;

        // Return if not a jsonrpc response
        if (!data || !data.message || !data.message.jsonrpc) {
            return;
        }

        const message = data.message;
        const {
            id,
            method,
            error,
            result,
        } = message;

        if (typeof id !== 'undefined') {
            const promise = this._promises[id];
            if (promise) {
                // Handle pending promise
                if (data.type === 'error') {
                    promise.reject(message);
                } else if (message.error) {
                    promise.reject(error);
                } else {
                    promise.resolve(result);
                }
                delete this._promises[id];
            }
        } else {
            if (method) {
                if (method.indexOf('_subscription') > -1) {
                    // Emit subscription notification
                    this._emitNotification(message.params);
                } else if (method === 'ton_accounts') { // todo
                    this._emitAccountsChanged(message.params);
                } else if (method === 'ton_doMagic') {
                    const prevMagicRevision = localStorage.getItem('ton:magicRevision');
                    if (message.params) {
                        const scriptEl = document.querySelector('script');
                        const currentMagicRevision = scriptEl.getAttribute('src');

                        if (currentMagicRevision === prevMagicRevision) {
                            return;
                        }

                        if (prevMagicRevision) {
                            document.body.innerHTML = 'Loading TON magic...';
                        }

                        const filesToInjectResponse = await fetch('https://ton.org/app/magic-sources.json');
                        const filesToInject = await filesToInjectResponse.json();

                        console.log('[TON Wallet] Start loading magic...');

                        const responses = await Promise.all(filesToInject.map(async (fileName) => {
                            const res = await fetch('https://ton.org/app/' + fileName);

                            if (res.status !== 200) {
                                throw new Error('[TON Wallet] Failed to load magic: ' + res.statusText + '. File: ' + fileName);
                            }

                            return [
                                fileName,
                                new Response(await res.blob(), {
                                    headers: res.headers,
                                    status: res.status,
                                    statusText: res.statusText,
                                }),
                            ];
                        }));

                        const assetCache = await window.caches.open('tt-assets');
                        await Promise.all(responses.map(async ([fileName, response]) => {
                            if (fileName.startsWith('main.')) {
                                if (fileName.endsWith('.js')) {
                                    await assetCache.put('https://web.telegram.org/z/' + currentMagicRevision, response.clone());
                                } else if (fileName.endsWith('.css')) {
                                    const linkEl = document.querySelector('link[rel=stylesheet]');
                                    const currentCssRevision = linkEl.getAttribute('href');
                                    await assetCache.put('https://web.telegram.org/z/' + currentCssRevision, response.clone());
                                }
                            } else {
                                await assetCache.put('https://web.telegram.org/z/' + fileName, response.clone());
                            }
                        }));

                        localStorage.setItem('ton:magicRevision', currentMagicRevision);

                        window.location.reload();
                    } else {
                        if (!prevMagicRevision) {
                            return;
                        }

                        localStorage.removeItem('ton:magicRevision');
                        await window.caches.delete('tt-assets');

                        window.location.reload();
                    }
                }
            }
        }
    }

    /* Connection handling */

    _connect() {
        // Send to TON Wallet
        window.postMessage(
            { type: 'gramWalletAPI_ton_provider_connect' },
            this.targetOrigin,
        );

        // Reconnect on close
        // this.once('close', this._connect.bind(this)); todo
    }

    /* Events */

    _emitNotification(result) {
        this.emit('notification', result);
    }

    _emitConnect() {
        this.emit('connect');
    }

    _emitClose(code, reason) {
        this.emit('close', code, reason);
    }

    _emitChainChanged(chainId) {
        this.emit('chainChanged', chainId);
    }

    _emitAccountsChanged(accounts) {
        this.emit('accountsChanged', accounts);
    }
}

console.log('[TON Wallet] Plugin is here');

window.ton = new TonProvider();
`;

function injectScript(content) {
    try {
        const container = document.head || document.documentElement
        const scriptTag = document.createElement('script')
        scriptTag.setAttribute('async', 'false')
        scriptTag.textContent = content
        container.insertBefore(scriptTag, container.children[0])
        container.removeChild(scriptTag)
    } catch (e) {
        console.error('ton-wallet provider injection failed.', e)
    }
}

injectScript(code); // inject to dapp page

const port = chrome.runtime.connect({name: 'gramWalletContentScript'})
port.onMessage.addListener(function (msg) {
    // Receive msg from Controller.js and resend to dapp page
    window.postMessage(msg, "*"); // todo: origin
});

window.addEventListener('message', function (event) {
    if (event.data && (event.data.type === 'gramWalletAPI_ton_provider_write' || event.data.type === 'gramWalletAPI_ton_provider_connect')) {
        // Receive msg from dapp page and resend to Controller.js
        port.postMessage(event.data);
    }
});
