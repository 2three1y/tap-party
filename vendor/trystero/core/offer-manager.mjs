import { all, alloc, mkErr, resetTimer } from "./utils.mjs";
//#region src/offer-manager.ts
const offerLeaseTtlMs = 18e4;
var OfferManager = class {
	makeOffer;
	leased = /* @__PURE__ */ new Map();
	destroyed = false;
	constructor(makeOffer) {
		this.makeOffer = makeOffer;
	}
	claimLeased(peer) {
		const timer = this.leased.get(peer);
		if (timer) {
			resetTimer(timer);
			this.leased.delete(peer);
		}
	}
	reclaimLeased(peer) {
		if (this.leased.has(peer)) {
			this.claimLeased(peer);
			peer.destroy();
		}
	}
	checkout(n, leaseOffers, encryptOffer) {
		const toRecord = async (didRetry = false) => {
			if (this.destroyed) throw mkErr("room left while preparing offer");
			const peer = this.makeOffer();
			try {
				const offer = await encryptOffer(peer);
				if (this.destroyed) throw mkErr("room left while preparing offer");
				if (leaseOffers) {
					this.leased.set(peer, setTimeout(() => {
						this.leased.delete(peer);
						peer.destroy();
					}, offerLeaseTtlMs));
					return {
						peer,
						offer,
						claim: () => this.claimLeased(peer),
						reclaim: () => this.reclaimLeased(peer)
					};
				}
				return {
					peer,
					offer
				};
			} catch (error) {
				peer.destroy();
				if (!didRetry && !this.destroyed) return toRecord(true);
				throw error;
			}
		};
		return all(alloc(n, () => toRecord()));
	}
	getOffers(n, encryptOffer) {
		return this.checkout(n, true, encryptOffer);
	}
	destroy() {
		this.destroyed = true;
		this.leased.forEach((timer, peer) => {
			resetTimer(timer);
			peer.destroy();
		});
		this.leased.clear();
	}
};
//#endregion
export { OfferManager };

