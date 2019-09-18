/**
* Licensed under the Apache License, Version 2.0 (the "License");
* you may not use this file except in compliance with the License.
* You may obtain a copy of the License at
*
* http://www.apache.org/licenses/LICENSE-2.0
*
* Unless required by applicable law or agreed to in writing, software
* distributed under the License is distributed on an "AS IS" BASIS,
* WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
* See the License for the specific language governing permissions and
* limitations under the License.
*
*/

'use strict';

const commUtils = require('../../comm/util');
const commLogger = commUtils.getLogger('e2eUtils.js');
const TxStatus  = require('../../comm/transaction');

const Client = require('fabric-client');
const fs = require('fs');
const util = require('util');
const testUtil = require('./util.js');

const signedOffline = require('./signTransactionOffline.js');

let Gateway, InMemoryWallet, X509WalletMixin;
let ORGS;
let isLegacy;
let tx_id = null;
let the_user = null;

let grpc = require('grpc');
let acceleratorProto = grpc.load({root: __dirname, file: 'protos/accelerator.proto'});
let acceleratorAddress;
let credential;
let grpcOptions;

let signedTransactionArray = [];
let signedCommitProposal = [];
let txFile;
let invokeCount = 0;
let clientIndex = 0;

/**
 * Initialize the Fabric client configuration.
 * @param {string} config_path The path of the Fabric network configuration file.
 */
function init(config_path) {
    const config = commUtils.parseYaml(config_path);
    ORGS = config.fabric.network;
    acceleratorAddress = require(config_path).accelerator.server;

    let tlsCert = require(config_path).fabric.tls_cert;
    if (tlsCert) {
        let data = fs.readFileSync(commUtils.resolvePath(tlsCert));
        credential = grpc.credentials.createSsl(Buffer.from(data));

        let tls_hostname = require(config_path).fabric.tls_hostname;
        grpcOptions = {
            'grpc.ssl_target_name_override': tls_hostname,
            'grpc.default_authority': tls_hostname
        };
    } else {
        credential = grpc.credentials.createInsecure();
    }

    isLegacy = (config.info.Version.startsWith('1.0') || config.info.Version.startsWith('1.1'));
    if(!isLegacy){
        Gateway = require('fabric-network').Gateway;
        InMemoryWallet = require('fabric-network').InMemoryWallet;
        X509WalletMixin = require('fabric-network').X509WalletMixin;
    }
}

/**
 * Enrol and get the cert
 * @param {*} fabricCAEndpoint url of org endpoint
 * @param {*} caName name of caName
 * @return {Object} something useful in a promise
 */
async function tlsEnroll(fabricCAEndpoint, caName) {
    const tlsOptions = {
        trustedRoots: [],
        verify: false
    };
    const caService = new FabricCAServices(fabricCAEndpoint, tlsOptions, caName);
    const req = {
        enrollmentID: 'admin',
        enrollmentSecret: 'adminpw',
        profile: 'tls'
    };

    const enrollment = await caService.enroll(req);
    enrollment.key = enrollment.key.toBytes();
    return enrollment;
}

/**
 * Read signed proposal from file.
 * @param {string} name The prefix name of the file.
 * @async
 */
async function readFromFile(name){
    try {
        signedTransactionArray = [];
        signedCommitProposal = [];
        invokeCount = 0;
        let fileName = name + '.signed.metadata.' + clientIndex;
        let binFileName = name + '.signed.binary.' + clientIndex;

        let data = fs.readFileSync(fileName);
        signedTransactionArray = JSON.parse(data);
        commLogger.debug('read buffer file ok');
        let signedBuffer = fs.readFileSync(binFileName);
        let start = 0;
        for(let i = 0; i < signedTransactionArray.length; i++) {
            let length = signedTransactionArray[i].signatureLength;
            let signature = signedBuffer.slice(start, start + length);
            start += length;
            length = signedTransactionArray[i].payloadLength;
            let payload = signedBuffer.slice(start, start + length);
            signedCommitProposal.push({signature: signature, payload: payload});
            start += length;
        }
    }catch(err) {
        commLogger.error('read err: ' + err);
    }
}

module.exports.readFromFile = readFromFile;

/**
 * Deploy the given chaincode to the given organization's peers.
 * @param {string} org The name of the organization.
 * @param {object} chaincode The chaincode object from the configuration file.
 * @async
 */
async function installChaincode(org, chaincode) {
    Client.setConfigSetting('request-timeout', 60000);
    const channel_name = chaincode.channel;

    const client = new Client();
    const channel = client.newChannel(channel_name);

    // Conditional action on TLS enablement
    if(ORGS.orderer.url.toString().startsWith('grpcs')){
        const fabricCAEndpoint = ORGS[org].ca.url;
        const caName = ORGS[org].ca.name;
        const tlsInfo = await tlsEnroll(fabricCAEndpoint, caName);
        client.setTlsClientCertAndKey(tlsInfo.certificate, tlsInfo.key);
    }

    const orgName = ORGS[org].name;
    const cryptoSuite = Client.newCryptoSuite();
    cryptoSuite.setCryptoKeyStore(Client.newCryptoKeyStore({path: testUtil.storePathForOrg(orgName)}));
    client.setCryptoSuite(cryptoSuite);

    const caRootsPath = ORGS.orderer.tls_cacerts;
    let data = fs.readFileSync(commUtils.resolvePath(caRootsPath));
    let caroots = Buffer.from(data).toString();

    channel.addOrderer(
        client.newOrderer(
            ORGS.orderer.url,
            {
                'pem': caroots,
                'ssl-target-name-override': ORGS.orderer['server-hostname']
            }
        )
    );

    const targets = [];
    for (let key in ORGS[org]) {
        if (ORGS[org].hasOwnProperty(key)) {
            if (key.indexOf('peer') === 0) {
                let data = fs.readFileSync(commUtils.resolvePath(ORGS[org][key].tls_cacerts));
                let peer = client.newPeer(
                    ORGS[org][key].requests,
                    {
                        pem: Buffer.from(data).toString(),
                        'ssl-target-name-override': ORGS[org][key]['server-hostname']
                    }
                );

                targets.push(peer);
                channel.addPeer(peer);
            }
        }
    }

    const store = await Client.newDefaultKeyValueStore({path: testUtil.storePathForOrg(orgName)});
    client.setStateStore(store);

    // get the peer org's admin required to send install chaincode requests
    the_user = await testUtil.getSubmitter(client, true /* get peer org admin */, org);

    // Don't re-install existing chaincode
    let peers = channel.getPeers();
    let res = await client.queryInstalledChaincodes(peers[0].constructor.name.localeCompare('Peer') === 0 ? peers[0] : peers[0]._peer);
    let found = false;
    for (let i = 0; i < res.chaincodes.length; i++) {
        if (res.chaincodes[i].name === chaincode.id &&
            res.chaincodes[i].version === chaincode.version &&
            res.chaincodes[i].path === chaincode.path) {
            found = true;
            commLogger.debug('installedChaincode: ' + JSON.stringify(res.chaincodes[i]));
            break;
        }
    }
    if (found) {
        return;
    }

    let resolvedPath = chaincode.path;
    let metadataPath = chaincode.metadataPath ? commUtils.resolvePath(chaincode.metadataPath) : chaincode.metadataPath;
    if (chaincode.language === 'node') {
        resolvedPath = commUtils.resolvePath(chaincode.path);
    }

    // send proposal to endorser
    const request = {
        targets: targets,
        chaincodePath: resolvedPath,
        metadataPath: metadataPath,
        chaincodeId: chaincode.id,
        chaincodeType: chaincode.language,
        chaincodeVersion: chaincode.version
    };

    const results = await client.installChaincode(request);

    const proposalResponses = results[0];

    let all_good = true;
    const errors = [];
    for(let i in proposalResponses) {
        let one_good = false;
        if (proposalResponses && proposalResponses[i].response && proposalResponses[i].response.status === 200) {
            one_good = true;
        } else {
            commLogger.error('install proposal was bad');
            errors.push(proposalResponses[i]);
        }
        all_good = all_good && one_good;
    }
    if (!all_good) {
        throw new Error(util.format('Failed to send install Proposal or receive valid response: %s', errors));
    }
}

/**
 * Assemble a chaincode proposal request.
 * @param {Client} client The Fabric client object.
 * @param {object} chaincode The chaincode object from the configuration file.
 * @param {boolean} upgrade Indicates whether the request is an upgrade or not.
 * @param {object} transientMap The transient map the request.
 * @param {object} endorsement_policy The endorsement policy object from the configuration file.
 * @return {object} The assembled chaincode proposal request.
 */
function buildChaincodeProposal(client, chaincode, upgrade, transientMap, endorsement_policy) {
    const tx_id = client.newTransactionID();

    // send proposal to endorser
    const request = {
        chaincodePath: chaincode.path,
        chaincodeId: chaincode.id,
        chaincodeType: chaincode.language,
        chaincodeVersion: chaincode.version,
        fcn: 'init',
        args: chaincode.init || [],
        txId: tx_id,
        'endorsement-policy': endorsement_policy
    };


    if(upgrade) {
        // use this call to test the transient map support during chaincode instantiation
        request.transientMap = transientMap;
    }

    return request;
}

/**
 * Instantiate or upgrade the given chaincode with the given endorsement policy.
 * @param {object} chaincode The chaincode object from the configuration file.
 * @param {object} endorsement_policy The endorsement policy object from the configuration file.
 * @param {boolean} upgrade Indicates whether the call is an upgrade or a new instantiation.
 * @async
 */
async function instantiate(chaincode, endorsement_policy, upgrade){
    Client.setConfigSetting('request-timeout', 600000);

    let channel = testUtil.getChannel(chaincode.channel);
    if(channel === null) {
        throw new Error('Could not find channel in config');
    }
    const channel_name = channel.name;
    const userOrg = channel.organizations[0];

    const targets = [];
    const eventhubs = [];
    let type = 'instantiate';
    if(upgrade) {type = 'upgrade';}
    const client = new Client();
    channel = client.newChannel(channel_name);

    const orgName = ORGS[userOrg].name;
    const cryptoSuite = Client.newCryptoSuite();
    cryptoSuite.setCryptoKeyStore(Client.newCryptoKeyStore({path: testUtil.storePathForOrg(orgName)}));
    client.setCryptoSuite(cryptoSuite);

    const caRootsPath = ORGS.orderer.tls_cacerts;
    let data = fs.readFileSync(commUtils.resolvePath(caRootsPath));
    let caroots = Buffer.from(data).toString();

    // Conditional action on TLS enablement
    if(ORGS.orderer.url.toString().startsWith('grpcs')){
        const fabricCAEndpoint = ORGS[userOrg].ca.url;
        const caName = ORGS[userOrg].ca.name;
        const tlsInfo = await tlsEnroll(fabricCAEndpoint, caName);
        client.setTlsClientCertAndKey(tlsInfo.certificate, tlsInfo.key);
    }

    channel.addOrderer(
        client.newOrderer(
            ORGS.orderer.url,
            {
                'pem': caroots,
                'ssl-target-name-override': ORGS.orderer['server-hostname']
            }
        )
    );

    const transientMap = {'test': 'transientValue'};
    let request = null;

    const store = await Client.newDefaultKeyValueStore({path: testUtil.storePathForOrg(orgName)});
    client.setStateStore(store);
    the_user = await testUtil.getSubmitter(client, true /* use peer org admin*/, userOrg);

    for(let org in ORGS) {
        if(ORGS.hasOwnProperty(org) && org.indexOf('org') === 0) {
            for (let key in ORGS[org]) {
                if(ORGS[org].hasOwnProperty(key) && key.indexOf('peer') === 0) {
                    let data = fs.readFileSync(commUtils.resolvePath(ORGS[org][key].tls_cacerts));
                    let peer = client.newPeer(
                        ORGS[org][key].requests,
                        {
                            pem: Buffer.from(data).toString(),
                            'ssl-target-name-override': ORGS[org][key]['server-hostname']
                        });
                    targets.push(peer);
                    channel.addPeer(peer);

                    const eh = channel.newChannelEventHub(peer);
                    eventhubs.push(eh);
                }
            }
        }
    }

    await channel.initialize();

    let res = await channel.queryInstantiatedChaincodes();
    let found = false;
    for (let i = 0; i < res.chaincodes.length; i++) {
        if (res.chaincodes[i].name === chaincode.id &&
            res.chaincodes[i].version === chaincode.version &&
            res.chaincodes[i].path === chaincode.path) {
            found = true;
            commLogger.debug('instantiatedChaincode: ' + JSON.stringify(res.chaincodes[i]));
            break;
        }
    }
    if (found) {
        return;
    }

    let results;
    // the v1 chaincode has Init() method that expects a transient map
    if (upgrade) {
        let request = buildChaincodeProposal(client, chaincode, upgrade, transientMap, endorsement_policy);
        tx_id = request.txId;
        results = await channel.sendUpgradeProposal(request);
    } else {
        let request = buildChaincodeProposal(client, chaincode, upgrade, transientMap, endorsement_policy);
        tx_id = request.txId;
        results = await channel.sendInstantiateProposal(request);
    }

    const proposalResponses = results[0];

    const proposal = results[1];
    let all_good = true;
    for(const i in proposalResponses) {
        if (proposalResponses && proposalResponses[i].response && proposalResponses[i].response.status === 200) {
            commLogger.info(type +' proposal was good');
        } else {
            commLogger.warn(type +' proposal was bad: ' + proposalResponses[i]);
            all_good = false;
        }
    }
    if (all_good) {
        commLogger.info('Successfully sent Proposal and received ProposalResponse');
        request = {
            proposalResponses: proposalResponses,
            proposal: proposal
        };
    } else {
        commLogger.warn(JSON.stringify(proposalResponses));
        throw new Error('All proposals were not good');
    }
    const deployId = tx_id.getTransactionID();

    const eventPromises = [];
    eventPromises.push(channel.sendTransaction(request));
    eventhubs.forEach((eh) => {
        let txPromise = new Promise((resolve, reject) => {
            let handle = setTimeout(reject, 300000);

            eh.registerTxEvent(deployId.toString(), (tx, code) => {
                commLogger.info('The chaincode ' + type + ' transaction has been committed on peer '+ eh.getPeerAddr());
                clearTimeout(handle);
                if (code !== 'VALID') {
                    commLogger.warn('The chaincode ' + type + ' transaction was invalid, code = ' + code);
                    reject();
                } else {
                    commLogger.info('The chaincode ' + type + ' transaction was valid.');
                    resolve();
                }
            }, (err) => {
                commLogger.warn('There was a problem with the instantiate event ' + err);
                clearTimeout(handle);
                reject();
            }, {
                disconnect: true
            });
            eh.connect();
        });
        eventPromises.push(txPromise);
    });

    results = await Promise.all(eventPromises);
    if (results && !(results[0] instanceof Error) && results[0].status === 'SUCCESS') {
        commLogger.info('Successfully sent ' + type + 'transaction to the orderer.');
    } else {
        commLogger.warn('Failed to order the ' + type + 'transaction. Error code: ' + results[0].status);
        throw new Error('Failed to order the ' + type + 'transaction. Error code: ' + results[0].status);
    }
}

/**
 * Instantiate or upgrade the given chaincode with the given endorsement policy.
 * @param {object} chaincode The chaincode object from the configuration file.
 * @param {object} endorsement_policy The endorsement policy object from the configuration file.
 * @param {boolean} upgrade Indicates whether the call is an upgrade or a new instantiation.
 * @async
 */
async function instantiateLegacy(chaincode, endorsement_policy, upgrade){

    Client.setConfigSetting('request-timeout', 600000);

    let channel = testUtil.getChannel(chaincode.channel);
    if(channel === null) {
        throw new Error('Could not find channel in config');
    }
    const channel_name = channel.name;
    const userOrg = channel.organizations[0];

    let targets = [],
        eventhubs = [];
    let type = 'instantiate';
    if(upgrade) {type = 'upgrade';}
    const client = new Client();
    channel = client.newChannel(channel_name);

    const orgName = ORGS[userOrg].name;
    const cryptoSuite = Client.newCryptoSuite();
    cryptoSuite.setCryptoKeyStore(Client.newCryptoKeyStore({path: testUtil.storePathForOrg(orgName)}));
    client.setCryptoSuite(cryptoSuite);

    const caRootsPath = ORGS.orderer.tls_cacerts;
    let data = fs.readFileSync(commUtils.resolvePath(caRootsPath));
    let caroots = Buffer.from(data).toString();

    channel.addOrderer(
        client.newOrderer(
            ORGS.orderer.url,
            {
                'pem': caroots,
                'ssl-target-name-override': ORGS.orderer['server-hostname']
            }
        )
    );

    targets = [];
    const transientMap = {'test': 'transientValue'};

    let store = await Client.newDefaultKeyValueStore({path: testUtil.storePathForOrg(orgName)});
    client.setStateStore(store);

    the_user = await testUtil.getSubmitter(client, true /* use peer org admin*/, userOrg);

    let eventPeer = null;
    for(let org in ORGS) {
        if(ORGS.hasOwnProperty(org) && org.indexOf('org') === 0) {
            for (let key in ORGS[org]) {
                if(ORGS[org].hasOwnProperty(key) && key.indexOf('peer') === 0) {
                    let data = fs.readFileSync(commUtils.resolvePath(ORGS[org][key].tls_cacerts));
                    let peer = client.newPeer(
                        ORGS[org][key].requests,
                        {
                            pem: Buffer.from(data).toString(),
                            'ssl-target-name-override': ORGS[org][key]['server-hostname']
                        });
                    targets.push(peer);
                    channel.addPeer(peer);
                    if(org === userOrg && !eventPeer) {
                        eventPeer = key;
                    }
                }
            }
        }
    }

    data = fs.readFileSync(commUtils.resolvePath(ORGS[userOrg][eventPeer].tls_cacerts));
    let eh = client.newEventHub();
    eh.setPeerAddr(
        ORGS[userOrg][eventPeer].events,
        {
            pem: Buffer.from(data).toString(),
            'ssl-target-name-override': ORGS[userOrg][eventPeer]['server-hostname']
        }
    );
    eh.connect();
    eventhubs.push(eh);

    try {
        // read the config block from the orderer for the channel
        // and initialize the verify MSPs based on the participating
        // organizations
        await channel.initialize();

        let res = await channel.queryInstantiatedChaincodes();
        let found = false;
        for (let i = 0; i < res.chaincodes.length; i++) {
            if (res.chaincodes[i].name === chaincode.id &&
                res.chaincodes[i].version === chaincode.version &&
                res.chaincodes[i].path === chaincode.path) {
                found = true;
                commLogger.debug('instantiatedChaincode: ' + JSON.stringify(res.chaincodes[i]));
                break;
            }
        }
        if (found) {
            return;
        }
        let results;
        // the v1 chaincode has Init() method that expects a transient map
        if (upgrade) {
            let request = buildChaincodeProposal(client, chaincode, upgrade, transientMap, endorsement_policy);
            tx_id = request.txId;

            results = await channel.sendUpgradeProposal(request);
        } else {
            let request = buildChaincodeProposal(client, chaincode, upgrade, transientMap, endorsement_policy);
            tx_id = request.txId;
            results = await channel.sendInstantiateProposal(request);
        }

        const proposalResponses = results[0];

        const proposal = results[1];
        let all_good = true;
        let instantiated = false;
        for(let i in proposalResponses) {
            commLogger.debug('instantiateChaincode responses: i=' + i + ' ' + JSON.stringify(proposalResponses[i]));
            let one_good = false;
            if (proposalResponses[i].response && proposalResponses[i].response.status === 200) {
                one_good = true;
                /*} else if (proposalResponses && proposalResponses[i] && proposalResponses[i].code === 2){
                if (proposalResponses[i].details && proposalResponses[i].details.indexOf('exists') !== -1) {
                    one_good = true;
                    instantiated = true;
                }*/

            }
            all_good = all_good && one_good;
        }

        if (!all_good) {
            throw new Error('Failed to send ' + type + ' Proposal or receive valid response. Response null or status is not 200.');
        }else if (instantiated) {
            return;
        }

        const request = {
            proposalResponses: proposalResponses,
            proposal: proposal,
        };

        // set the transaction listener and set a timeout of 5 mins
        // if the transaction did not get committed within the timeout period,
        // fail the test
        const deployId = tx_id.getTransactionID();

        const eventPromises = [];
        eventhubs.forEach((eh) => {
            let txPromise = new Promise((resolve, reject) => {
                let handle = setTimeout(reject, 300000);

                eh.registerTxEvent(deployId.toString(), (tx, code) => {
                    clearTimeout(handle);
                    eh.unregisterTxEvent(deployId);

                    if (code !== 'VALID') {
                        commLogger.warn('The chaincode ' + type + ' transaction was invalid, code = ' + code);
                        reject();
                    } else {
                        commLogger.info('The chaincode ' + type + ' transaction was valid.');
                        resolve();
                    }
                });
            });
            eventPromises.push(txPromise);
        });

        let response;
        try {
            const sendPromise = channel.sendTransaction(request);
            results = await Promise.all([sendPromise].concat(eventPromises));
            response = results[0]; // just first results are from orderer, the rest are from the peer events
        } catch (err) {
            commLogger.error('Failed to send ' + type + ' transaction and get notifications within the timeout period.');
            throw err;
        }

        //TODO should look into the event responses
        if ((response instanceof Error) || response.status !== 'SUCCESS') {
            throw new Error('Failed to order the ' + type + 'transaction. Error code: ' + response.status);
        }
    } finally {
        for(let key in eventhubs) {
            const eventhub = eventhubs[key];
            if (eventhub && eventhub.isconnected()) {
                eventhub.disconnect();
            }
        }
    }
}

/**
 * Instantiate or upgrade the given chaincode with the given endorsement policy.
 * @param {object} chaincode The chaincode object from the configuration file.
 * @param {object} endorsement_policy The endorsement policy object from the configuration file.
 * @param {boolean} upgrade Indicates whether the call is an upgrade or a new instantiation.
 * @async
 */
async function instantiateChaincode(chaincode, endorsement_policy, upgrade){

    if (isLegacy) {
        await instantiateLegacy(chaincode, endorsement_policy, upgrade);
    } else {
        await instantiate(chaincode, endorsement_policy, upgrade);
    }
}

/**
 * Get the peers of a given organization.
 * @param {string} orgName The name of the organization.
 * @return {string[]} The collection of peer names.
 */
function getOrgPeers(orgName) {
    const peers = [];
    const org = ORGS[orgName];
    for (let key in org) {
        if ( org.hasOwnProperty(key)) {
            if (key.indexOf('peer') === 0) {
                peers.push(org[key]);
            }
        }
    }

    return peers;
}

/**
 * Create a Fabric context based on the channel configuration.
 * @param {object} channelConfig The channel object from the configuration file.
 * @param {Integer} clientIdx the client index
 * @param {object} txModeFile The file information for reading or writing.
 * @return {Promise<object>} The created Fabric context.
 */
async function getcontext(channelConfig, clientIdx, txModeFile) {
    clientIndex = clientIdx;
    txFile = txModeFile;
    Client.setConfigSetting('request-timeout', 120000);
    const channel_name = channelConfig.name;
    // var userOrg = channelConfig.organizations[0];
    // choose a random org to use, for load balancing
    const idx = Math.floor(Math.random() * channelConfig.organizations.length);
    const userOrg = channelConfig.organizations[idx];

    const client = new Client();
    const channel = client.newChannel(channel_name);
    let orgName = ORGS[userOrg].name;

    let acceleratorClient = new acceleratorProto.AcceleratorService(acceleratorAddress, credential, grpcOptions);

    const cryptoSuite = Client.newCryptoSuite();
    const eventhubs = [];

    // Conditional action on TLS enablement
    if(ORGS[userOrg].ca.url.toString().startsWith('https')){
        const fabricCAEndpoint = ORGS[userOrg].ca.url;
        const caName = ORGS[userOrg].ca.name;
        const tlsInfo = await tlsEnroll(fabricCAEndpoint, caName);
        client.setTlsClientCertAndKey(tlsInfo.certificate, tlsInfo.key);
    }

    cryptoSuite.setCryptoKeyStore(Client.newCryptoKeyStore({path: testUtil.storePathForOrg(orgName)}));
    client.setCryptoSuite(cryptoSuite);

    const caRootsPath = ORGS.orderer.tls_cacerts;
    let data = fs.readFileSync(commUtils.resolvePath(caRootsPath));
    let caroots = Buffer.from(data).toString();

    channel.addOrderer(
        client.newOrderer(
            ORGS.orderer.url,
            {
                'pem': caroots,
                'ssl-target-name-override': ORGS.orderer['server-hostname']
            }
        )
    );

    orgName = ORGS[userOrg].name;

    const store = await Client.newDefaultKeyValueStore({path: testUtil.storePathForOrg(orgName)});
    client.setStateStore(store);
    the_user = await testUtil.getSubmitter(client, true, userOrg);

    // set up the channel to use each org's random peer for
    // both requests and events
    for(let i in channelConfig.organizations) {
        let org   = channelConfig.organizations[i];
        let peers = getOrgPeers(org);

        if(peers.length === 0) {
            throw new Error('could not find peer of ' + org);
        }

        // Cycle through available peers based on clientIdx
        let peerInfo = peers[clientIdx % peers.length];
        let data = fs.readFileSync(commUtils.resolvePath(peerInfo.tls_cacerts));
        let peer = client.newPeer(
            peerInfo.requests,
            {
                pem: Buffer.from(data).toString(),
                'ssl-target-name-override': peerInfo['server-hostname']
            }
        );
        channel.addPeer(peer);

        // an event listener can only register with the peer in its own org
        if (isLegacy){
            let eh = client.newEventHub();
            eh.setPeerAddr(
                peerInfo.events,
                {
                    pem: Buffer.from(data).toString(),
                    'ssl-target-name-override': peerInfo['server-hostname'],
                    //'request-timeout': 120000
                    'grpc.keepalive_timeout_ms' : 3000, // time to respond to the ping, 3 seconds
                    'grpc.keepalive_time_ms' : 360000   // time to wait for ping response, 6 minutes
                    // 'grpc.http2.keepalive_time' : 15
                }
            );
            eventhubs.push(eh);
        } else {
            if(org === userOrg) {
                let eh = channel.newChannelEventHub(peer);
                eventhubs.push(eh);
            }
        }
    }

    // register event listener
    eventhubs.forEach((eh) => {
        eh.connect();
    });

    await channel.initialize();
    return {
        org: userOrg,
        client: client,
        channel: channel,
        submitter: the_user,
        eventhubs: eventhubs,
        accelerator: acceleratorClient
    };
}


/**
 * Disconnect the event hubs.
 * @param {object} context The Fabric context.
 * @async
 */
async function releasecontext(context) {
    if(context.hasOwnProperty('eventhubs')){
        for(let key in context.eventhubs) {
            const eventhub = context.eventhubs[key];
            if (eventhub && eventhub.isconnected()) {
                eventhub.disconnect();
            }
        }
        context.eventhubs = [];
    }
}

/**
 * Write signed proposal to file.
 * @param {string} name The prefix name of the file.
 * @async
 */
async function writeToFile(name){
    let fileName = name + '.signed.metadata.' + clientIndex;
    let binFileName = name + '.signed.binary.' + clientIndex;

    try {
        let reArray = [];
        let bufferArray = [];
        for(let i = 0; i < signedTransactionArray.length; i++) {
            let signedTransaction = signedTransactionArray[i];
            let signedProposal = signedTransactionArray[i].signedTransaction;
            let signature = signedProposal.signature;
            bufferArray.push(signature);
            let payload = signedProposal.payload;
            bufferArray.push(payload);
            reArray.push({txId: signedTransaction.txId, transactionRequest: signedTransaction.transactionRequest, signatureLength: signature.length, payloadLength: payload.length});
        }
        let buffer = Buffer.concat(bufferArray);

        fs.writeFileSync(binFileName, buffer);
        let signedString = JSON.stringify(reArray);
        fs.writeFileSync(fileName, signedString);
        signedTransactionArray = [];
        signedCommitProposal = [];
        commLogger.debug('write file ok');

    }catch(err) {
        commLogger.error('write err: ' + err);
    }

}

module.exports.writeToFile = writeToFile;

const TxErrorEnum = require('./constant.js').TxErrorEnum;
const TxErrorIndex = require('./constant.js').TxErrorIndex;


/**
 * Submit a transaction to the orderer.
 * @param {object} context The Fabric context.
 * @param {object} signedTransaction The transaction information.
 * @param {object} invokeStatus The result and stats of the transaction.
 * @param {number} startTime The start time.
 * @param {number} timeout The timeout for the transaction invocation.
 * @return {Promise<TxStatus>} The result and stats of the transaction invocation.
 */
async function sendTransaction(context, signedTransaction, invokeStatus, startTime, timeout){

    const channel = context.channel;
    const eventHubs = context.eventhubs;
    const txId = signedTransaction.txId;
    let errFlag = TxErrorEnum.NoError;
    try {
        let newTimeout = timeout * 1000 - (Date.now() - startTime);
        if(newTimeout < 10000) {
            commLogger.warn('WARNING: timeout is too small, default value is used instead');
            newTimeout = 10000;
        }

        const eventPromises = [];
        eventHubs.forEach((eh) => {
            eventPromises.push(new Promise((resolve, reject) => {
                //let handle = setTimeout(() => reject(new Error('Timeout')), newTimeout);
                let handle = setTimeout(() => reject(new Error('Timeout')), 100000);
                eh.registerTxEvent(txId,
                    (tx, code) => {
                        clearTimeout(handle);
                        eh.unregisterTxEvent(txId);

                        // either explicit invalid event or valid event, verified in both cases by at least one peer
                        invokeStatus.SetVerification(true);
                        if (code !== 'VALID') {
                            let err = new Error('Invalid transaction: ' + code);
                            errFlag |= TxErrorEnum.BadEventNotificationError;
                            invokeStatus.SetFlag(errFlag);
                            invokeStatus.SetErrMsg(TxErrorIndex.BadEventNotificationError, err.toString());
                            reject(err); // handle error in final catch
                        } else {
                            resolve();
                        }
                    },
                    (err) => {
                        clearTimeout(handle);
                        // we don't know what happened, but give the other eventhub connections a chance
                        // to verify the Tx status, so resolve this call
                        errFlag |= TxErrorEnum.EventNotificationError;
                        invokeStatus.SetFlag(errFlag);
                        invokeStatus.SetErrMsg(TxErrorIndex.EventNotificationError, err.toString());
                        resolve();
                    }
                );

            }));
        });

        let broadcastResponse;
        try {
            let signedProposal = signedTransaction.signedTransaction;
            let broadcastResponsePromise;
            let transactionRequest = signedTransaction.transactionRequest;
            if (signedProposal === null){
                if(txFile && txFile.readWrite === 'write') {
                    const beforeInvokeTime = Date.now();
                    let signedTransaction = signedOffline.generateSignedTransaction(transactionRequest, channel);
                    invokeStatus.Set('invokeLatency', (Date.now() - beforeInvokeTime));
                    signedTransactionArray.push({
                        txId: txId,
                        signedTransaction: signedTransaction,
                        transactionRequest: {orderer: transactionRequest.orderer}
                    });
                    return invokeStatus;
                }
                const beforeTransactionTime = Date.now();
                broadcastResponsePromise = channel.sendTransaction(transactionRequest);
                invokeStatus.Set('sT', (Date.now() - beforeTransactionTime));
            } else {
                const beforeTransactionTime = Date.now();
                //let signature = Buffer.from(signedProposal.signature.data);
                //let payload = Buffer.from(signedProposal.payload.data);
                let signature = signedProposal.signature;
                let payload =  signedProposal.payload;
                broadcastResponsePromise = channel.sendSignedTransaction({
                    signedProposal: {signature: signature, payload: payload},
                    request: signedTransaction.transactionRequest,
                });
                invokeStatus.Set('sT', (Date.now() - beforeTransactionTime));
                invokeStatus.Set('invokeLatency', (Date.now() - startTime));
            }
            broadcastResponse = await broadcastResponsePromise;
        } catch (err) {
            commLogger.error('Failed to send transaction error: ' + err);
            // missing the ACK does not mean anything, the Tx could be already under ordering
            // so let the events decide the final status, but log this error
            errFlag |= TxErrorEnum.OrdererResponseError;
            invokeStatus.SetFlag(errFlag);
            invokeStatus.SetErrMsg(TxErrorIndex.OrdererResponseError,err.toString());
        }

        invokeStatus.Set('time_order', Date.now());

        if (broadcastResponse && broadcastResponse.status === 'SUCCESS') {
            invokeStatus.Set('status', 'submitted');
        } else if (broadcastResponse && broadcastResponse.status !== 'SUCCESS') {
            let err = new Error('Received rejection from orderer service: ' + broadcastResponse.status);
            errFlag |= TxErrorEnum.BadOrdererResponseError;
            invokeStatus.SetFlag(errFlag);
            invokeStatus.SetErrMsg(TxErrorIndex.BadOrdererResponseError, err.toString());
            // the submission was explicitly rejected, so the Tx will definitely not be ordered
            invokeStatus.SetVerification(true);
            throw err;
        }

        await Promise.all(eventPromises);
        // if the Tx is not verified at this point, then every eventhub connection failed (with resolve)
        // so mark it failed but leave it not verified
        if (!invokeStatus.IsVerified()) {
            invokeStatus.SetStatusFail();
            commLogger.error('Failed to complete transaction [' + txId.substring(0, 5) + '...]: every eventhub connection closed');
        } else {
            invokeStatus.SetStatusSuccess();
        }
    } catch (err)
    {
        // at this point the Tx should be verified
        invokeStatus.SetStatusFail();
        commLogger.error('Failed to complete transaction [' + txId.substring(0, 5) + '...]:' + (err instanceof Error ? err.stack : err));
    }
    return invokeStatus;
}

/**
 * Submit a transaction to the given chaincode with the specified options.
 * @param {object} context The Fabric context.
 * @param {string} id The name of the chaincode.
 * @param {string} version The version of the chaincode.
 * @param {string[]} args The arguments to pass to the chaincode.
 * @param {number} timeout The timeout for the transaction invocation.
 * @return {Promise<TxStatus>} The result and stats of the transaction invocation.
 */
function invokebycontext(context, id, version, args, timeout) {
    const invokeStatus = new TxStatus('');

    const f = args[0];
    args.shift();

    let byteArgs = [];
    for (let i = 0; i < args.length; i++) {
        byteArgs.push(Buffer.from(args[i], 'utf8'));
    }

    const request = {
        channelId: context.channel.getName(),
        chaincodeName: id,
        fcn: f,
        args: byteArgs
    };

    if (context.engine) {
        context.engine.submitCallback(1);
    }

    return new Promise((resolve, reject) => {
        context.accelerator.execute(request, (error, data) => {
            if (!error) {
                invokeStatus.SetID(data.txId);
                invokeStatus.SetStatusSuccess();
                invokeStatus.SetResult(data.payload);
                resolve(invokeStatus);
            } else {
                console.log('Invoke chaincode failed: ' + (error.stack ? error.stack : error));
                invokeStatus.SetStatusFail();
                invokeStatus.SetFlag(error.code);
                invokeStatus.error_messages = error.message;
                resolve(invokeStatus);
            }
        });
    });
}

/**
 * Submit a query to the given chaincode with the specified options.
 * @param {object} context The Fabric context.
 * @param {string} id The name of the chaincode.
 * @param {string} version The version of the chaincode.
 * @param {string} name The single argument to pass to the chaincode.
 * @param {string} fcn The chaincode query function name.
 * @return {Promise<object>} The result and stats of the transaction invocation.
 */
function querybycontext(context, id, version, name, fcn) {
    const client = context.client;
    const tx_id = client.newTransactionID();
    const txStatus = new TxStatus(tx_id.getTransactionID());

    let args = [name];
    let byteArgs = [];
    for (let i = 0; i < args.length; i++) {
        byteArgs.push(Buffer.from(args[i], 'utf8'));
    }

    // send query
    const request = {
        channelId: context.channel.getName(),
        chaincodeName: id,
        fcn: fcn,
        args: byteArgs
    };

    if (context.engine) {
        context.engine.submitCallback(1);
    }

    return new Promise((resolve, reject) => {
        context.accelerator.query(request, (error, data) => {
            if (!error) {
                txStatus.SetStatusSuccess();
                txStatus.SetResult(data[0]);
                resolve(txStatus);
            } else {
                console.log('Query chaincode failed: ' + (error.stack ? error.stack : error));
                txStatus.SetStatusFail();
                txStatus.SetFlag(error.code);
                txStatus.error_messages = error.message;
                resolve(txStatus);
            }
        });
    });
}


/**
 * Utility method to recursively resolve the tlsCACerts paths listed within the passed json object
 * @param {Object} jsonObj a json object defining a common connection profile
 */
function resolveTlsCACerts(jsonObj) {
    if( typeof jsonObj === 'object' ) {
        Object.entries(jsonObj).forEach(([key, value]) => {
            // key is either an array index or object key
            if(key.toString() === 'tlsCACerts'){
                value.path = commUtils.resolvePath(value.path);
                return;
            } else {
                resolveTlsCACerts(value);
            }
        });
    } else {
        return;
    }
}

/**
 * Create and return an InMemoryWallet for a user in the org
 * @param {String} org the org
 * @returns {InMemoryWallet} an InMemoryWallet
 */
async function createInMemoryWallet(org) {
    const orgConfig = ORGS[org];
    const cert = fs.readFileSync(commUtils.resolvePath(orgConfig.user.cert)).toString();
    const key = fs.readFileSync(commUtils.resolvePath(orgConfig.user.key)).toString();
    const inMemoryWallet = new InMemoryWallet();

    await inMemoryWallet.import(orgConfig.user.name, X509WalletMixin.createIdentity(orgConfig.mspid, cert, key));

    if (ORGS.orderer.url.startsWith('grpcs')) {
        const fabricCAEndpoint = orgConfig.ca.url;
        const caName = orgConfig.ca.name;
        const tlsInfo = await tlsEnroll(fabricCAEndpoint, caName);
        await inMemoryWallet.import('tlsId', X509WalletMixin.createIdentity(org, tlsInfo.certificate, tlsInfo.key));
    }

    return inMemoryWallet;
}

/**
 * Retrieve the Gateway object for use in subsequent network invocation commands
 * @param {String} ccpPath the path to the common connection profile for the network
 * @param {String} opts the name of the organisation to use
 * @returns {Network} the Fabric Network object
 */
async function retrieveGateway(ccpPath, opts) {
    const gateway = new Gateway();

    ccpPath = commUtils.resolvePath(ccpPath);
    let ccp = JSON.parse(fs.readFileSync(ccpPath).toString());

    // need to resolve tlsCACerts paths for current system
    resolveTlsCACerts(ccp);

    await gateway.connect(ccp, opts);
    return gateway;
}

/**
 * Submit a transaction to the given chaincode with the specified options.
 * @param {object} context The Fabric context.
 * @param {string[]} args The arguments to pass to the chaincode.
 * @return {Promise<TxStatus>} The result and stats of the transaction invocation.
 */
async function submitTransaction(context, args){
    const TxErrorEnum = require('./constant.js').TxErrorEnum;
    const txIdObject = context.gateway.client.newTransactionID();
    const txId = txIdObject.getTransactionID().toString();

    // timestamps are recorded for every phase regardless of success/failure
    let invokeStatus = new TxStatus(txId);
    let errFlag = TxErrorEnum.NoError;
    invokeStatus.SetFlag(errFlag);

    if(context.engine) {
        context.engine.submitCallback(1);
    }

    try {
        const result = await context.contract.submitTransaction(...args);
        invokeStatus.result = result;
        invokeStatus.verified = true;
        invokeStatus.SetStatusSuccess();
        return invokeStatus;
    } catch (err) {
        invokeStatus.SetStatusFail();
        invokeStatus.result = [];
        return Promise.resolve(invokeStatus);
    }
}

/**
 * Executes a the given chaincode function with the specified options; this will not append to the ledger
 * @param {object} context The Fabric context.
 * @param {string[]} args The arguments to pass to the chaincode.
 * @return {Promise<TxStatus>} The result and stats of the transaction invocation.
 */
async function executeTransaction(context, args){
    const TxErrorEnum = require('./constant.js').TxErrorEnum;
    const txIdObject = context.gateway.client.newTransactionID();
    const txId = txIdObject.getTransactionID().toString();

    // timestamps are recorded for every phase regardless of success/failure
    let invokeStatus = new TxStatus(txId);
    let errFlag = TxErrorEnum.NoError;
    invokeStatus.SetFlag(errFlag);

    if(context.engine) {
        context.engine.submitCallback(1);
    }

    try {
        const result = await context.contract.executeTransaction(...args);
        invokeStatus.result = result;
        invokeStatus.SetStatusSuccess();
        return invokeStatus;
    } catch (err) {
        invokeStatus.SetStatusFail();
        invokeStatus.result = [];
        return Promise.resolve(invokeStatus);
    }
}

module.exports.init = init;
module.exports.installChaincode = installChaincode;
module.exports.instantiateChaincode = instantiateChaincode;
module.exports.getcontext = getcontext;
module.exports.releasecontext = releasecontext;
module.exports.invokebycontext = invokebycontext;
module.exports.querybycontext = querybycontext;
module.exports.createInMemoryWallet = createInMemoryWallet;
module.exports.retrieveGateway = retrieveGateway;
module.exports.submitTransaction = submitTransaction;
module.exports.executeTransaction = executeTransaction;
