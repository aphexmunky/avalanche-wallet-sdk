import HDKey from 'hdkey';
import { getPreferredHRP } from 'avalanche/dist/utils';
import { activeNetwork, avalanche, pChain, xChain } from '@/Network/network';
import { KeyPair as AVMKeyPair, KeyChain as AVMKeyChain } from 'avalanche/dist/apis/avm/keychain';
import { KeyChain as PlatformKeyChain, KeyPair as PlatformKeyPair } from 'avalanche/dist/apis/platformvm';
import { HdChainType } from './types';
import { Buffer } from 'avalanche';
import { INDEX_RANGE, SCAN_RANGE, SCAN_SIZE } from './constants';
import { getAddressChains } from '../Explorer/Explorer';
import { NO_NETWORK } from '@/errors';
import { bintools } from '@/common';

type AddressCache = {
    [index: string]: HDKey;
};

type KeyCacheX = {
    [index: string]: AVMKeyPair;
};

type KeyCacheP = {
    [index: string]: PlatformKeyPair;
};

// Each HD wallet has 2 HdScaners, one for internal chain, one for external
export default class HdScanner {
    protected index = 0;
    protected addressCache: AddressCache = {};
    protected keyCacheX: KeyCacheX = {};
    protected keyCacheP: KeyCacheP = {};
    readonly changePath: string;
    readonly accountKey: HDKey;

    constructor(accountKey: HDKey, isInternal = true) {
        this.changePath = isInternal ? '1' : '0';
        this.accountKey = accountKey;
    }

    getIndex() {
        return this.index;
    }

    public increment(): number {
        return this.index++;
    }

    public getAddressX() {
        return this.getAddressForIndex(this.index, 'X');
    }

    public getAddressP() {
        return this.getAddressForIndex(this.index, 'P');
    }

    public getAllAddresses(chainId: HdChainType = 'X'): string[] {
        let upTo = this.index;
        let addrs = [];
        for (let i = 0; i <= upTo; i++) {
            addrs.push(this.getAddressForIndex(i, chainId));
        }
        return addrs;
    }

    getAddressesInRange(start: number, end: number): string[] {
        let res = [];
        for (let i = start; i < end; i++) {
            res.push(this.getAddressForIndex(i));
        }
        return res;
    }

    getKeyChainX(): AVMKeyChain {
        let keychain = xChain.newKeyChain();
        for (let i = 0; i <= this.index; i++) {
            let key = this.getKeyForIndexX(i);
            keychain.addKey(key);
        }
        return keychain;
    }

    getKeyChainP(): PlatformKeyChain {
        let keychain = pChain.newKeyChain();
        for (let i = 0; i <= this.index; i++) {
            let key = this.getKeyForIndexP(i);
            keychain.addKey(key);
        }
        return keychain;
    }

    getKeyForIndexX(index: number): AVMKeyPair {
        let cache = this.keyCacheX[index];
        if (cache) return cache;

        let hdKey = this.getHdKeyForIndex(index);
        let pkHex = hdKey.privateKey.toString('hex');

        let pkBuf: Buffer = new Buffer(pkHex, 'hex');

        let keychain = xChain.newKeyChain();
        let keypair = keychain.importKey(pkBuf);

        this.keyCacheX[index] = keypair;
        return keypair;
    }

    getKeyForIndexP(index: number): PlatformKeyPair {
        let cache = this.keyCacheP[index];
        if (cache) return cache;

        let hdKey = this.getHdKeyForIndex(index);
        let pkHex = hdKey.privateKey.toString('hex');

        let pkBuf: Buffer = new Buffer(pkHex, 'hex');

        let keychain = pChain.newKeyChain();
        let keypair = keychain.importKey(pkBuf);

        this.keyCacheP[index] = keypair;

        return keypair;
    }

    private getHdKeyForIndex(index: number): HDKey {
        let key: HDKey;
        if (this.addressCache[index]) {
            key = this.addressCache[index];
        } else {
            key = this.accountKey.derive(`m/${this.changePath}/${index}`) as HDKey;
            this.addressCache[index] = key;
        }
        return key;
    }

    private getAddressForIndex(index: number, chainId: HdChainType = 'X'): string {
        let key = this.getHdKeyForIndex(index);

        let publicKey = key.publicKey.toString('hex');
        let publicKeyBuff = Buffer.from(publicKey, 'hex');

        let hrp = getPreferredHRP(avalanche.getNetworkID());

        let keypair = new AVMKeyPair(hrp, chainId);
        let addrBuf = keypair.addressFromPublicKey(publicKeyBuff);
        let addr = bintools.addressToString(hrp, chainId, addrBuf);

        return addr;
    }

    // Uses the explorer to scan used addresses and find its starting index
    public async resetIndex(startIndex = 0): Promise<number> {
        if (!activeNetwork) throw NO_NETWORK;

        let index;
        if (activeNetwork.explorerURL) {
            index = await this.findAvailableIndexExplorer(startIndex);
        } else {
            index = await this.findAvailableIndexNode(startIndex);
        }
        this.index = index;
        return index;
    }

    // Scans the address space of this hd path and finds the last used index using the
    // explorer API.
    private async findAvailableIndexExplorer(startIndex = 0): Promise<number> {
        let upTo = 512;

        let addrs = this.getAddressesInRange(startIndex, startIndex + upTo);
        let addrChains = await getAddressChains(addrs);

        for (let i = 0; i < addrs.length - INDEX_RANGE; i++) {
            let gapSize: number = 0;

            for (let n = 0; n < INDEX_RANGE; n++) {
                let scanIndex = i + n;
                let scanAddr = addrs[scanIndex];

                let rawAddr = scanAddr.split('-')[1];
                let chains: string[] = addrChains[rawAddr];

                if (!chains) {
                    // If doesnt exist on any chain
                    gapSize++;
                } else {
                    i = i + n;
                    break;
                }
            }

            // If the gap is reached return the index
            if (gapSize === INDEX_RANGE) {
                return startIndex + i;
            }
        }

        return await this.findAvailableIndexExplorer(startIndex + (upTo - INDEX_RANGE));
    }

    // Uses the node to find last used HD index
    // Only used when there is no explorer API available
    private async findAvailableIndexNode(start = 0): Promise<number> {
        let addrsX: string[] = [];
        let addrsP: string[] = [];

        // Get keys for indexes start to start+scan_size
        for (let i: number = start; i < start + SCAN_SIZE; i++) {
            let addressX = this.getAddressForIndex(i, 'X');
            let addressP = this.getAddressForIndex(i, 'P');
            addrsX.push(addressX);
            addrsP.push(addressP);
        }

        let utxoSetX = (await xChain.getUTXOs(addrsX)).utxos;
        let utxoSetP = (await pChain.getUTXOs(addrsP)).utxos;

        // Scan UTXOs of these indexes and try to find a gap of INDEX_RANGE
        for (let i: number = 0; i < addrsX.length - INDEX_RANGE; i++) {
            let gapSize: number = 0;
            for (let n: number = 0; n < INDEX_RANGE; n++) {
                let scanIndex: number = i + n;
                let addr: string = addrsX[scanIndex];
                let addrBuf = bintools.parseAddress(addr, 'X');
                let addrUTXOsX: string[] = utxoSetX.getUTXOIDs([addrBuf]);
                let addrUTXOsP: string[] = utxoSetP.getUTXOIDs([addrBuf]);
                if (addrUTXOsX.length === 0 && addrUTXOsP.length === 0) {
                    gapSize++;
                } else {
                    // Potential improvement
                    i = i + n;
                    break;
                }
            }

            // If we found a gap of 20, we can return the last fullIndex+1
            if (gapSize === INDEX_RANGE) {
                let targetIndex = start + i;
                return targetIndex;
            }
        }
        return await this.findAvailableIndexNode(start + SCAN_RANGE);
    }
}
