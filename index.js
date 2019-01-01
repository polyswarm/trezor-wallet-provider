'use strict';

var HookedWalletSubprovider = require('web3-provider-engine/subproviders/hooked-wallet.js');
var Transaction = require('ethereumjs-tx');
var trezor = require('trezor.js');
var util = require('util');
var bippath = require('bip32-path')

var debug = false;

function normalize(hex) {
    if (hex == null) {
        return null;
    }
    if (hex.startsWith("0x")) {
        hex = hex.substring(2);
    }
    if (hex.length % 2 != 0) {
        hex = "0" + hex;
    }
    return hex;
}

var exec = require('child_process').exec;
function execute(command) {
    return new Promise((resolve, reject) => {
        exec(command, function(error, stdout, stderr) {
            if (error != null) {
                reject(error);
            } else {
                resolve(stdout);
            }
        });
    });
};

function getUserHome() {
    return process.env[(process.platform == 'win32') ? 'USERPROFILE' : 'HOME'];
}

function buffer(hex) {
    if (hex == null) {
        return new Buffer('', 'hex');
    } else {
        return new Buffer(normalize(hex), 'hex');
    }
}

var trezorInstance;

class Trezor {
    constructor(path) {
        var self = this;

        this.accountsMap = {};
        this.devices = [];
        this.path = path;
        this.address = null;
        this.initialized = this.initSession();
        this.nonce = -1;
    }

    initSession() {
        var self = this;
        return new Promise(function(resolve, reject) {
            self.list = new trezor.DeviceList({debug: debug});
            self.list.acquireFirstDevice().then(obj => {
                self.device = obj.device;
                self.session = obj.session;

                obj.device.on('passphrase', callback => {
                    execute("java -cp " + require.resolve("./ui-0.1.0.jar") + " io.daonomic.trezor.AskPassphrase")
                        .then(out => callback(null, out.trim()))
                        .catch(callback);
                });

                obj.device.on('pin', (type, callback) => {
                    execute("java -cp " + require.resolve("./ui-0.1.0.jar") + " io.daonomic.trezor.AskPin")
                        .then(out => callback(null, out.trim()))
                        .catch(callback);
                });

                // For convenience, device emits 'disconnect' event on disconnection.
                obj.device.on('disconnect', function () {
                    console.log("Disconnected device");
                    self.device = null;
                    self.session = null;
                });

                obj.session.ethereumGetAddress(self.path, false)
                    .then(resp => "0x" + resp.message.address)
                    .then(address => { self.address = address; console.log("Current address: " + address + "\n");
                    resolve(self.session) })
                    .catch(console.log)
            }).catch(console.log);
        })
    }

    getAccounts(cb) {
        var self = this;
        this.initialized
            .then(session => self.address)
            .then(address => cb(null, [address]))
            .catch(cb)
    }

    signTransaction(txParams, cb) {
        // TODO this is a hack to try to keep better track of nonces,
        // since Infura often gets out of sync, sometimes by multiple nonces.
        // It should work as long as nothing else is issuing txs from the
        // same account.
        if (this.nonce < 1 || parseInt(txParams.nonce) > this.nonce) {
            this.nonce = parseInt(txParams.nonce);
        } else {
            this.nonce += 1;
            var hexString = this.nonce.toString(16);
            txParams.nonce = "0x" + hexString;
        }
        var self = this;
        this.initialized
            .then(session => session.signEthTx(self.path, normalize(txParams.nonce), normalize(txParams.gasPrice), normalize(txParams.gas), normalize(txParams.to), normalize(txParams.value), normalize(txParams.data)))
            .then(result => {
                const tx = new Transaction({
                   nonce: buffer(txParams.nonce),
                   gasPrice: buffer(txParams.gasPrice),
                   gasLimit: buffer(txParams.gas),
                   to: buffer(txParams.to),
                   value: buffer(txParams.value),
                   data: buffer(txParams.data),
                   v: result.v,
                   r: buffer(result.r),
                   s: buffer(result.s)
                });
                cb(null, '0x' + tx.serialize().toString('hex'));
            })
            .catch(cb);
    }

    static init(path) {
        if (trezorInstance == null) {
            trezorInstance = new Trezor(path);
        } else {
            trezorInstance.path = path;
        }
        return trezorInstance;
    }
}

class TrezorProvider extends HookedWalletSubprovider {
    constructor(path) {
        var pathArray = bippath.fromString(path).toPathArray();
        var trezor = Trezor.init(pathArray);
        super({
            getAccounts: function(cb) {
                trezor.getAccounts(cb);
            },
            signTransaction: function(txParams, cb) {
                trezor.signTransaction(txParams, cb);
            }
        });
    }
}

module.exports = TrezorProvider;

