import { DateString, Base64String, Serializable } from "./encoding";
import { getProvider, RSAPublicKey, RSAPrivateKey, SharedContainer, AccessorStatus, KeyExchange } from "./crypto";
import { Storable } from "./storage";
import { StoreID } from "./data";
import { DeviceInfo } from "./platform";
import { Err, ErrorCode } from "./error";
import { uuid } from "./util";

export type AccountID = string;
export type SessionID = string;
export type DeviceID = string;
export type OrganizationID = string;

export class Device implements Serializable, DeviceInfo {
    id: string = "";
    platform: string = "";
    osVersion: string = "";
    appVersion: string = "";
    manufacturer?: string;
    model?: string;
    browser?: string;
    userAgent: string = "";

    get description(): string {
        return this.browser ? `${this.browser} on ${this.platform}` : `${this.platform + " Device"}`;
    }

    async serialize() {
        return {
            id: this.id,
            platform: this.platform,
            osVersion: this.osVersion,
            appVersion: this.appVersion,
            manufacturer: this.manufacturer,
            model: this.model,
            browser: this.browser,
            userAgent: this.userAgent
        };
    }

    async deserialize(raw: any) {
        Object.assign(this, raw);
        return this;
    }
}

export class Session implements Serializable {
    id: string = "";
    token: string = "";
    email: string = "";
    created: DateString = new Date().toISOString();
    active: boolean = false;
    lastUsed?: DateString;
    expires?: DateString;
    device: Device = new Device();
    account?: Account;

    async serialize() {
        return {
            id: this.id,
            email: this.email,
            token: this.token,
            created: this.created,
            active: this.active,
            lastUsed: this.lastUsed,
            expires: this.expires,
            device: this.device && (await this.device.serialize())
        };
    }

    async deserialize(raw: any) {
        await this.device.deserialize(raw.device);
        delete raw.device;
        Object.assign(this, raw);
        return this;
    }
}

export interface PublicAccount {
    id: AccountID;
    email: string;
    name: string;
    publicKey: RSAPublicKey;
}

export class Account implements Storable, PublicAccount {
    kind = "account";
    id: AccountID = "";
    name = "";
    created: DateString = new Date().toISOString();
    updated: DateString = new Date().toISOString();
    sharedStores: StoreID[] = [];
    organizations: OrganizationID[] = [];
    publicKey: RSAPublicKey = "";
    privateKey: RSAPrivateKey = "";
    trustedAccounts: PublicAccount[] = [];
    sessions: Session[] = [];
    // TODO
    subscription?: { status: string };
    promo?: any;
    paymentSource?: any;

    constructor(public email: string = "") {}

    get pk() {
        return this.email;
    }

    get publicAccount(): PublicAccount {
        return { id: this.id, email: this.email, publicKey: this.publicKey, name: this.name };
    }

    async serialize() {
        return {
            id: this.id,
            created: this.created,
            updated: this.updated,
            email: this.email,
            name: this.name,
            sharedStores: this.sharedStores,
            publicKey: this.publicKey,
            sessions: await Promise.all(this.sessions.map(s => s.serialize()))
        };
    }

    async deserialize(raw: any) {
        this.sessions = ((await Promise.all(
            raw.sessions.map((s: any) => new Session().deserialize(s))
        )) as any) as Session[];
        delete raw.sessions;
        Object.assign(this, raw);
        return this;
    }

    async generateKeyPair() {
        const { publicKey, privateKey } = await getProvider().generateKey({
            algorithm: "RSA",
            modulusLength: 2048,
            publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
            hash: "SHA-1"
        });
        this.publicKey = publicKey;
        this.privateKey = privateKey;
    }

    // TODO: omit private key?
    // toJSON() {
    //     return JSON.stringify(Object.assign({}, this, { privateKey: "[omitted]" }));
    // }
}

export interface OrganizationMember extends PublicAccount {
    signedPublicKey: Base64String;
}

export class Invite extends KeyExchange {
    id: string = "";
    sent: boolean = false;

    async serialize() {
        return Object.assign({ id: this.id, sent: this.sent }, await super.serialize());
    }

    async deserialize(raw: any) {
        await super.deserialize(raw);
        this.id = raw.id;
        this.sent = raw.sent;
        return this;
    }
}

export class Organization implements Storable {
    kind = "organization";

    owner: AccountID = "";
    privateKey: RSAPrivateKey = "";
    publicKey: RSAPublicKey = "";
    members: OrganizationMember[] = [];

    private _container: SharedContainer;

    private _invites = new Map<string, Invite>();

    get invites() {
        return Array.from(this._invites.values());
    }

    get pk() {
        return this.id;
    }

    constructor(public id: OrganizationID, public account: Account, public name = "") {
        this._container = new SharedContainer(this.account);
    }

    private get _secretSerializer(): Serializable {
        return {
            serialize: async () => {
                return {
                    privateKey: this.privateKey,
                    invites: this.invites.map(({ id, expires, secret }) => {
                        return { id, expires, secret };
                    })
                };
            },
            deserialize: async (raw: any) => {
                this.privateKey = raw.privateKey;
                for (const { id, expires, secret } of raw.invites) {
                    const invite = this._invites.get(id);
                    invite && Object.assign(invite, { expires, secret });
                }
                return this;
            }
        };
    }

    async initialize() {
        await this._container.initialize(this.account.publicAccount);
        await this.addMember(this.account.publicAccount);
    }

    async serialize() {
        if (this._container.hasAccess) {
            await this._container.set(this._secretSerializer);
        }
        return {
            id: this.id,
            owner: this.owner,
            name: this.name,
            publicKey: this.publicKey,
            members: this.members,
            invites: await Promise.all(this.invites.map(i => i.serialize())),
            encryptedData: await this._container.serialize()
        };
    }

    async deserialize(raw: any) {
        this.id = raw.id;
        this.owner = raw.owner;
        this.name = raw.name;
        this.publicKey = raw.publicKey;
        this.members = raw.members;
        await Promise.all(
            raw.invites.map(async (i: any) => {
                this._invites.set(i.id, await new Invite().deserialize(i));
            })
        );
        await this._container.deserialize(raw.encryptedData);
        if (this._container.hasAccess) {
            await this._container.get(this._secretSerializer);
        }
        return this;
    }

    isOwner(account: PublicAccount) {
        return this.owner === account.id;
    }

    isAdmin(account: PublicAccount) {
        if (this.isOwner(account)) {
            return true;
        }
        const accessor = this._container.getAccessor(account.id);
        return accessor && accessor.status === "active";
    }

    isMember(account: PublicAccount) {
        return !!this.members.find(m => m.id === account.id);
    }

    async generateKeyPair() {
        const { publicKey, privateKey } = await getProvider().generateKey({
            algorithm: "RSA",
            modulusLength: 2048,
            publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
            hash: "SHA-1"
        });
        this.publicKey = publicKey;
        this.privateKey = privateKey;
    }

    async addMember(account: PublicAccount) {
        if (!this._container.hasAccess) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        if (!this.publicKey || !this.privateKey) {
            await this.generateKeyPair();
        }

        if (this.members.find(m => m.id === account.id)) {
            throw "Already a member";
        }

        const member = Object.assign({}, account, {
            signedPublicKey: await getProvider().sign(this.privateKey, account.publicKey, {
                algorithm: "RSA-PSS",
                hash: "SHA-1",
                saltLength: 128
            })
        });

        this.members.push(member);
    }

    async addAdmin(account: PublicAccount) {
        if (!this._container.hasAccess) {
            throw new Err(ErrorCode.INSUFFICIENT_PERMISSIONS);
        }

        await this._container.updateAccessor(
            Object.assign({}, account, {
                status: "active" as AccessorStatus,
                permissions: { read: true, write: true, manage: true },
                encryptedKey: "",
                updated: "",
                updatedBy: ""
            })
        );

        if (!this.members.find(m => m.id === account.id)) {
            await this.addMember(account);
        }
    }

    async verifyMember(member: OrganizationMember) {
        let verified = false;
        try {
            verified = await getProvider().verify(this.publicKey, member.signedPublicKey, member.publicKey, {
                algorithm: "RSA-PSS",
                hash: "SHA-1",
                saltLength: 128
            });
        } catch (e) {}
        return verified;
    }

    getInvite(id: string) {
        return this._invites.get(id);
    }

    async createInvite(email: string) {
        if (!this.isAdmin(this.account)) {
            return new Err(ErrorCode.INSUFFICIENT_PERMISSIONS);
        }
        const invite = new Invite();
        invite.id = uuid();
        await invite.initialize(email, this.account.publicAccount);
        this._invites.set(invite.id, invite);
    }
}
