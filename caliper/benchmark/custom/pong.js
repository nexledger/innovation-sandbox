'use strict';

module.exports.info = 'query ping';

let bc, contx;
let ccName = 'ping';

module.exports.init = function (blockchain, context, args) {
    bc = blockchain;
    contx = context;

    return Promise.resolve();
};

module.exports.run = function () {
    return bc.queryState(contx, ccName, 'v0', 'ping', 'pong');
};

module.exports.end = function () {
    return Promise.resolve();
};
