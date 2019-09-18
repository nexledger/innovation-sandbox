'use strict';

module.exports.info = 'execute ping';

let bc, contx;
let ccName = 'ping';

module.exports.init = function (blockchain, context, args) {
    bc = blockchain;
    contx = context;

    return Promise.resolve();
};

module.exports.run = function () {
    return bc.invokeSmartContract(contx, ccName, 'v0', {'fcn': 'ping', 'key': 'ping', 'val': '100'}, 100);
};

module.exports.end = function () {
    return Promise.resolve();
};
