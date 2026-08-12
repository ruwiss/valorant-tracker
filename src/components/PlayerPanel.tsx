import { useState, useEffect, useRef } from "react";
import { invokeCommand } from "../utils/ipc";
import { useGameStore } from "../stores/gameStore";
import { usePanelStore } from "../stores/panelStore";
import { useAssetsStore } from "../stores/assetsStore";
import { useI18n, SKIN_API_LOCALES, getLocalizedRank } from "../lib/i18n";
import { WEAPON_NAMES, AGENT_COLORS, RANK_TIERS } from "../lib/constants";
import { CachedImage } from "./CachedImage";

// Resolve a Google-detected source language code (e.g. "ru", "ja") to a short
// human-readable name in the active UI locale (e.g. "Russian" / "Rusça").
// Falls back to the upper-cased code if Intl.DisplayNames can't resolve it.
const langDisplayName = (code: string, uiLocale: string): string => {
	if (!code || code === "auto" || code === "und") return "";
	try {
		const dn = new Intl.DisplayNames([uiLocale === "tr" ? "tr" : "en"], {
			type: "language",
		});
		return dn.of(code) || code.toUpperCase();
	} catch {
		return code.toUpperCase();
	}
};

interface WeaponSkin {
	weapon_id: string;
	skin_id: string;
	chroma_id: string | null;
	buddy_id: string | null;
}
interface EquippedExpression {
	socket_id: string;
	asset_id: string;
	kind: "spray" | "flex" | string;
}
interface PlayerSkinData {
	puuid: string;
	skins: WeaponSkin[];
	expressions?: EquippedExpression[];
}
interface SkinInfo {
	name: string;
	icon: string;
}
interface BuddyInfo {
	name: string;
	icon: string;
}
interface WeaponInfo {
	displayIcon: string;
}
interface ExpressionInfo {
	name: string;
	icon: string;
	kind: "spray" | "flex";
	midRoundLocked: boolean;
}

type WheelSlot = "top" | "right" | "bottom" | "left";

const WHEEL_SLOT_ORDER: WheelSlot[] = ["top", "right", "bottom", "left"];

// Known expression-wheel socket IDs (clockwise from top). Unknown sockets fall back to API order.
const WHEEL_SOCKETS: Record<string, WheelSlot> = {
	"0814b2fe-4513-70a4-5117-a6eef18593c5": "top",
	"04af080a-4071-487b-61c0-5b9c0cfaac74": "right",
	"5863985e-43ac-b05d-cb2d-139e72970014": "bottom",
	"7cc032a6-4c8c-e34b-c58d-e8488944f442": "left",
	"d7374f95-450b-a891-7714-eac36837cd29": "top",
};

// Icon *center* sits on the cardinal axis, ~2/3 of the radius out — the
// visual middle of each X-slice, not the rim and not the hub.
const WHEEL_SLOT_CLASS: Record<WheelSlot, string> = {
	top: "left-1/2 top-[20%] -translate-x-1/2 -translate-y-1/2",
	right: "left-[80%] top-1/2 -translate-x-1/2 -translate-y-1/2",
	bottom: "left-1/2 top-[80%] -translate-x-1/2 -translate-y-1/2",
	left: "left-[20%] top-1/2 -translate-x-1/2 -translate-y-1/2",
};

function WheelIcon({ src }: { src?: string }) {
	const [ready, setReady] = useState(false);

	useEffect(() => {
		setReady(false);
	}, [src]);

	return (
		<div className="relative flex h-14 w-14 items-center justify-center">
			{!ready && (
				<div className="absolute h-8 w-8 rounded-full bg-accent-gold/10 ring-1 ring-accent-gold/15" />
			)}
			{src && (
				<CachedImage
					silent
					src={src}
					alt=""
					onLoad={() => setReady(true)}
					className="max-h-14 max-w-14 object-contain drop-shadow-[0_4px_12px_rgba(0,0,0,0.75)] transition-[filter] duration-200 group-hover:drop-shadow-[0_0_14px_rgba(0,212,170,0.55)]"
				/>
			)}
		</div>
	);
}

interface PeakRankData {
	tier: number;
	rank_name: string;
	rank_color: string;
	season_id: string;
}

// Weapon categories for better organization
const WEAPON_CATEGORIES = {
	primary: [
		"9c82e19d-4575-0200-1a81-3eacf00cf872", // Vandal
		"ee8e8d15-496b-07ac-e5f6-8fae5d4c7b1a", // Phantom
		"a03b24d3-4319-996d-0f8c-94bbfba1dfc7", // Operator
		"4ade7faa-4cf1-8376-95ef-39884480959b", // Guardian
		"ae3de142-4d85-2547-dd26-4e90bed35cf7", // Bulldog
		"c4883e50-4494-202c-3ec3-6b8a9284f00b", // Marshal
		"5f0aaf7a-4289-3998-d5ff-eb9a5cf7ef5c", // Outlaw
		"462080d1-4035-2937-7c09-27aa2a5c27a7", // Spectre
	],
	secondary: [
		"f7e1b454-4ad4-1063-ec0a-159e56b58941", // Stinger
		"e336c6b8-418d-9340-d77f-7a9e4cfe0702", // Sheriff
		"1baa85b4-4c70-1284-64bb-6481dfc3bb4e", // Ghost
		"29a0cfab-485b-f5d5-779a-b59f85e204a8", // Classic
		"42da8ccc-40d5-affc-beec-15aa47b42eda", // Shorty
		"44d4e95c-4157-0037-81b2-17841bf2e8e3", // Frenzy
		"410b2e0b-4ceb-1321-1727-20858f7f3477", // Bandit
	],
	other: [
		"63e6c2b6-4a8e-869c-3d4c-e38355226584", // Odin
		"55d8a0f4-4274-ca67-fe2c-06ab45efdf58", // Ares
		"ec845bf4-4f79-ddda-a3da-0db3774b2794", // Judge
		"910be174-449b-c412-ab22-d0873436b21b", // Bucky
		"2f59173c-4bed-b6c3-2191-dea9b58be9c7", // Melee
	],
};

const skinMetaCache = new Map<string, Map<string, SkinInfo>>();
const buddyMetaCache = new Map<string, Map<string, BuddyInfo>>();
const weaponIconCache = new Map<string, WeaponInfo>();
const expressionMetaCache = new Map<string, Map<string, ExpressionInfo>>();

export function PlayerPanel() {
	const { selectedPlayer, setHoveredWeapon } = usePanelStore();
	const { getAgentIcon } = useAssetsStore();
	const matchId = useGameStore((state) => state.gameState.match_id); // Get match_id
	const { t, locale } = useI18n();
	const [skins, setSkins] = useState<WeaponSkin[]>([]);
	const [expressions, setExpressions] = useState<EquippedExpression[]>([]);
	const [skinMeta, setSkinMeta] = useState<Map<string, SkinInfo>>(new Map());
	const [buddyMeta, setBuddyMeta] = useState<Map<string, BuddyInfo>>(new Map());
	const [expressionMeta, setExpressionMeta] = useState<
		Map<string, ExpressionInfo>
	>(new Map());
	const [weaponIcons, setWeaponIcons] = useState<Map<string, WeaponInfo>>(
		new Map(),
	);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [copied, setCopied] = useState(false);
	const [translatedName, setTranslatedName] = useState<string | null>(null);
	const [detectedLang, setDetectedLang] = useState<string | null>(null);
	const [isTranslating, setIsTranslating] = useState(false);
	const [peakRank, setPeakRank] = useState<PeakRankData | null>(null);
	const fetchedRef = useRef<string | null>(null);

	// Reset state when player changes
	useEffect(() => {
		setSkins([]);
		setExpressions([]);
		setSkinMeta(new Map());
		setBuddyMeta(new Map());
		setExpressionMeta(new Map());
		setError(null);
		setLoading(false);
		setTranslatedName(null);
		setDetectedLang(null);
		setIsTranslating(false);
		setPeakRank(null);

		if (selectedPlayer?.puuid) {
			invokeCommand<PeakRankData | null>("get_peak_rank", {
				puuid: selectedPlayer.puuid,
			})
				.then(setPeakRank)
				.catch(console.error);
		}
	}, [selectedPlayer?.puuid]);

	useEffect(() => {
		if (!selectedPlayer) {
			fetchedRef.current = null;
			return;
		}
		// Include matchId in cache key to force refetch on new match
		const cacheKey = `${selectedPlayer.puuid}-${matchId}-${locale}`;
		if (fetchedRef.current === cacheKey) return;
		fetchLoadout(selectedPlayer.puuid, cacheKey);
	}, [selectedPlayer?.puuid, matchId, locale]);

	// Fetch weapon icons once
	useEffect(() => {
		if (weaponIconCache.size === 0) {
			fetchWeaponIcons();
		} else {
			setWeaponIcons(new Map(weaponIconCache));
		}
	}, []);

	const fetchWeaponIcons = async () => {
		try {
			const res = await fetch("https://valorant-api.com/v1/weapons");
			if (!res.ok) return;
			const json = await res.json();
			for (const weapon of json.data || []) {
				weaponIconCache.set(weapon.uuid.toLowerCase(), {
					displayIcon: weapon.displayIcon || "",
				});
			}
			setWeaponIcons(new Map(weaponIconCache));
		} catch (err) {
			console.debug("[PlayerPanel] weapon icon fetch failed:", err);
		}
	};

	const fetchLoadout = async (puuid: string, cacheKey: string) => {
		fetchedRef.current = cacheKey;
		setLoading(true);
		setError(null);
		try {
			const data = await invokeCommand<PlayerSkinData | null>(
				"get_player_loadout",
				{ puuid },
			);
			if (usePanelStore.getState().selectedPlayer?.puuid !== puuid) return;
			if (!data) {
				setError(t("player.loadoutNotFound"));
				setLoading(false);
				return;
			}

			setSkins(data.skins);
			const equippedExpressions = data.expressions || [];
			setExpressions(equippedExpressions);
			const apiLocale = SKIN_API_LOCALES[locale];

			// Skin meta cache
			if (!skinMetaCache.has(apiLocale))
				skinMetaCache.set(apiLocale, new Map());
			const localeCache = skinMetaCache.get(apiLocale)!;
			const uncachedIds = data.skins
				.map((s) => s.chroma_id || s.skin_id)
				.filter((id) => !localeCache.has(id.toLowerCase()));
			if (uncachedIds.length > 0)
				await fetchSkinMeta(uncachedIds, apiLocale, localeCache);
			const meta = new Map<string, SkinInfo>();
			data.skins.forEach((s) => {
				const id = (s.chroma_id || s.skin_id).toLowerCase();
				const c = localeCache.get(id);
				if (c) meta.set(id, c);
			});
			setSkinMeta(meta);

			// Buddy meta cache
			if (!buddyMetaCache.has(apiLocale))
				buddyMetaCache.set(apiLocale, new Map());
			const buddyCache = buddyMetaCache.get(apiLocale)!;
			const buddyIds = data.skins
				.map((s) => s.buddy_id)
				.filter((id): id is string => !!id && !buddyCache.has(id));
			if (buddyIds.length > 0)
				await fetchBuddyMeta(buddyIds, apiLocale, buddyCache);
			const bMeta = new Map<string, BuddyInfo>();
			data.skins.forEach((s) => {
				if (s.buddy_id) {
					const b = buddyCache.get(s.buddy_id);
					if (b) bMeta.set(s.buddy_id, b);
				}
			});
			setBuddyMeta(bMeta);

			if (!expressionMetaCache.has(apiLocale))
				expressionMetaCache.set(apiLocale, new Map());
			const exprCache = expressionMetaCache.get(apiLocale)!;
			const exprIds = equippedExpressions
				.map((e) => e.asset_id.toLowerCase())
				.filter((id) => !exprCache.has(id));
			if (exprIds.length > 0)
				await fetchExpressionMeta(exprIds, apiLocale, exprCache);
			const eMeta = new Map<string, ExpressionInfo>();
			equippedExpressions.forEach((e) => {
				const id = e.asset_id.toLowerCase();
				const info = exprCache.get(id);
				if (info) eMeta.set(id, info);
			});
			setExpressionMeta(eMeta);
		} catch {
			setError(t("player.connectionError"));
		} finally {
			setLoading(false);
		}
	};

	const fetchSkinMeta = async (
		skinIds: string[],
		apiLocale: string,
		cache: Map<string, SkinInfo>,
	) => {
		try {
			const res = await fetch(
				`https://valorant-api.com/v1/weapons/skins?language=${apiLocale}`,
			);
			if (!res.ok) return;
			const json = await res.json();
			// Normalize skinIds to lowercase for consistent comparison
			const lowerSkinIds = skinIds.map((id) => id.toLowerCase());
			for (const skin of json.data || []) {
				const skinUuidLower = skin.uuid.toLowerCase();
				if (lowerSkinIds.includes(skinUuidLower)) {
					cache.set(skinUuidLower, {
						name: skin.displayName || "Unknown",
						icon: skin.displayIcon || skin.chromas?.[0]?.displayIcon || "",
					});
				}
				for (const chroma of skin.chromas || []) {
					const chromaUuidLower = chroma.uuid.toLowerCase();
					if (lowerSkinIds.includes(chromaUuidLower)) {
						cache.set(chromaUuidLower, {
							name: chroma.displayName || skin.displayName || "Unknown",
							icon:
								chroma.displayIcon ||
								chroma.fullRender ||
								skin.displayIcon ||
								"",
						});
					}
				}
			}
		} catch (err) {
			console.debug("[PlayerPanel] skin meta fetch failed:", err);
		}
	};

	const fetchBuddyMeta = async (
		buddyIds: string[],
		apiLocale: string,
		cache: Map<string, BuddyInfo>,
	) => {
		try {
			const res = await fetch(
				`https://valorant-api.com/v1/buddies?language=${apiLocale}`,
			);
			if (!res.ok) return;
			const json = await res.json();
			for (const buddy of json.data || []) {
				if (buddyIds.includes(buddy.uuid)) {
					cache.set(buddy.uuid, {
						name: buddy.displayName || "Unknown",
						icon: buddy.displayIcon || "",
					});
				}
				for (const level of buddy.levels || []) {
					if (buddyIds.includes(level.uuid)) {
						cache.set(level.uuid, {
							name: buddy.displayName || "Unknown",
							icon: level.displayIcon || buddy.displayIcon || "",
						});
					}
				}
			}
		} catch (err) {
			console.debug("[PlayerPanel] buddy meta fetch failed:", err);
		}
	};

	const fetchExpressionMeta = async (
		assetIds: string[],
		apiLocale: string,
		cache: Map<string, ExpressionInfo>,
	) => {
		const wanted = new Set(assetIds.map((id) => id.toLowerCase()));
		try {
			const [sprayRes, flexRes] = await Promise.all([
				fetch(`https://valorant-api.com/v1/sprays?language=${apiLocale}`),
				fetch(`https://valorant-api.com/v1/flex?language=${apiLocale}`),
			]);

			if (sprayRes.ok) {
				const json = await sprayRes.json();
				for (const spray of json.data || []) {
					const sprayId = String(spray.uuid || "").toLowerCase();
					const info: ExpressionInfo = {
						name: spray.displayName || "Spray",
						icon:
							spray.fullTransparentIcon ||
							spray.fullIcon ||
							spray.displayIcon ||
							"",
						kind: "spray",
						midRoundLocked:
							spray.category === "EAresSprayCategory::Contextual",
					};
					if (wanted.has(sprayId)) cache.set(sprayId, info);
					for (const level of spray.levels || []) {
						const levelId = String(level.uuid || "").toLowerCase();
						if (wanted.has(levelId)) {
							cache.set(levelId, {
								...info,
								icon:
									level.displayIcon ||
									info.icon,
							});
						}
					}
				}
			}

			if (flexRes.ok) {
				const json = await flexRes.json();
				for (const flex of json.data || []) {
					const flexId = String(flex.uuid || "").toLowerCase();
					if (!wanted.has(flexId)) continue;
					cache.set(flexId, {
						name: flex.displayName || "Flex",
						icon: flex.displayIcon || "",
						kind: "flex",
						midRoundLocked: false,
					});
				}
			}
		} catch (err) {
			console.debug("[PlayerPanel] expression meta fetch failed:", err);
		}
	};

	/** True once a successful translate finished (empty string = no useful change). */
	const translateDone =
		translatedName !== null && translatedName !== "Hata";

	/** Translate a single name/tag fragment via Rust (same path as chat `!t`). */
	const translateFragment = async (
		text: string,
		targetLang: string,
	): Promise<{ text: string; src: string } | null> => {
		const trimmed = text.trim();
		if (!trimmed) return null;

		const result = await invokeCommand<{
			text: string;
			source_lang: string;
		}>("translate_text", { text: trimmed, targetLang }, {
			suppressErrorToast: true,
		});

		if (!result?.text) {
			// invokeCommand rethrows on Err; null should not happen for Ok.
			throw new Error("Translation returned empty");
		}

		const translatedText = result.text.trim();
		if (!translatedText) throw new Error("Translation returned empty");
		if (translatedText.toLowerCase() === trimmed.toLowerCase()) {
			return null; // no useful translation (already target language / same text)
		}
		return { text: translatedText, src: result.source_lang || "" };
	};

	const handleTranslate = async (e: React.MouseEvent) => {
		e.stopPropagation();
		// Allow retry after error; block only after a successful attempt.
		if (!selectedPlayer || isTranslating || translateDone) return;

		setIsTranslating(true);
		setTranslatedName(null);
		setDetectedLang(null);
		try {
			const full = selectedPlayer.name;
			const hashIdx = full.indexOf("#");
			const namePart = hashIdx >= 0 ? full.slice(0, hashIdx) : full;
			const tagPart = hashIdx >= 0 ? full.slice(hashIdx + 1) : "";
			const targetLang = locale === "tr" ? "tr" : "en";

			// Translate name and tag independently so one can succeed without the other.
			const [nameSettled, tagSettled] = await Promise.allSettled([
				translateFragment(namePart, targetLang),
				tagPart ? translateFragment(tagPart, targetLang) : Promise.resolve(null),
			]);
			const nameResult =
				nameSettled.status === "fulfilled" ? nameSettled.value : null;
			const tagResult =
				tagSettled.status === "fulfilled" ? tagSettled.value : null;
			const nameFailed = nameSettled.status === "rejected";
			const tagFailed = Boolean(tagPart) && tagSettled.status === "rejected";
			if (nameFailed && (tagFailed || !tagPart)) {
				throw new Error("Translation failed");
			}

			// Build display: only include parts that actually changed.
			// - only name  → "Name"
			// - only tag   → "#Tag"
			// - both       → "Name#Tag"
			// - neither    → "" (render nothing, not "-")
			let display = "";
			if (nameResult && tagResult) {
				display = `${nameResult.text}#${tagResult.text}`;
			} else if (nameResult) {
				display = nameResult.text;
			} else if (tagResult) {
				display = `#${tagResult.text}`;
			}

			setTranslatedName(display);

			const srcCode = nameResult?.src || tagResult?.src || "";
			setDetectedLang(
				display && srcCode && srcCode !== targetLang ? srcCode : null,
			);
		} catch (err) {
			console.error("Google Translation failed:", err);
			setTranslatedName("Hata");
			setDetectedLang(null);
		} finally {
			setIsTranslating(false);
		}
	};

	const copyName = () => {
		if (selectedPlayer) {
			navigator.clipboard.writeText(selectedPlayer.name);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		}
	};

	if (!selectedPlayer) return null;

	const agentIcon = selectedPlayer.agent
		? getAgentIcon(selectedPlayer.agent)
		: null;
	const agentColor =
		AGENT_COLORS[selectedPlayer.agent?.toLowerCase()] || "#768079";

	const [, rankColor] = RANK_TIERS[selectedPlayer.rank_tier] || ["", "#768079"];
	const rankName = getLocalizedRank(selectedPlayer.rank_tier, locale);

	const cardBannerUrl = selectedPlayer.player_card_id
		? `https://media.valorant-api.com/playercards/${selectedPlayer.player_card_id}/wideart.png`
		: null;

	// Group skins by category - lowercase keys for case-insensitive matching
	const skinsByWeaponId = new Map(
		skins.map((s) => [s.weapon_id.toLowerCase(), s]),
	);

	const getWeaponIcon = (skin: WeaponSkin): string => {
		const id = (skin.chroma_id || skin.skin_id).toLowerCase();
		const meta = skinMeta.get(id);
		// Use skin icon if available, otherwise fallback to weapon default icon
		if (meta?.icon) return meta.icon;
		return weaponIcons.get(skin.weapon_id.toLowerCase())?.displayIcon || "";
	};

	const handleWeaponHover = (skin: WeaponSkin | null) => {
		if (!skin) {
			setHoveredWeapon(null);
			return;
		}
		const id = (skin.chroma_id || skin.skin_id).toLowerCase();
		const meta = skinMeta.get(id);
		const weaponType = WEAPON_NAMES[skin.weapon_id.toLowerCase()] || "?";
		const icon = getWeaponIcon(skin);
		const buddy = skin.buddy_id
			? buddyMeta.get(skin.buddy_id.toLowerCase())
			: undefined;
		setHoveredWeapon({
			name: meta?.name || weaponType,
			icon,
			weaponType,
			buddy,
		});
	};

	const handleExpressionHover = (expr: EquippedExpression | null) => {
		if (!expr) {
			setHoveredWeapon(null);
			return;
		}
		const info = expressionMeta.get(expr.asset_id.toLowerCase());
		const kind = info?.kind || (expr.kind === "flex" ? "flex" : "spray");
		setHoveredWeapon({
			name: info?.name || (kind === "flex" ? t("weapons.flex") : t("weapons.spray")),
			icon: info?.icon || "",
			weaponType: kind === "flex" ? t("weapons.flex") : t("weapons.spray"),
			note: info?.midRoundLocked ? t("player.midRoundLocked") : undefined,
		});
	};

	const assignWheelSlots = (
		items: EquippedExpression[],
	): Partial<Record<WheelSlot, EquippedExpression>> => {
		const assigned: Partial<Record<WheelSlot, EquippedExpression>> = {};
		const leftovers: EquippedExpression[] = [];
		for (const item of items) {
			const slot = WHEEL_SOCKETS[item.socket_id.toLowerCase()];
			if (slot && !assigned[slot]) assigned[slot] = item;
			else leftovers.push(item);
		}
		for (const item of leftovers) {
			const free = WHEEL_SLOT_ORDER.find((s) => !assigned[s]);
			if (!free) break;
			assigned[free] = item;
		}
		return assigned;
	};

	const renderWeaponCard = (weaponId: string, isPrimary = false) => {
		const skin = skinsByWeaponId.get(weaponId.toLowerCase());
		// Don't return null here - we want to render the weapon even if no skin data

		const id = (skin?.chroma_id || skin?.skin_id || "").toLowerCase();
		const meta = id ? skinMeta.get(id) : undefined;
		const weaponName = WEAPON_NAMES[weaponId.toLowerCase()] || "?";

		// Get icon: skin icon -> weapon default icon
		const icon = skin
			? getWeaponIcon(skin)
			: weaponIcons.get(weaponId.toLowerCase())?.displayIcon || "";
		const hasBuddy =
			skin?.buddy_id && buddyMeta.has(skin.buddy_id.toLowerCase());

		// Mock skin object for hover handler if real skin is missing
		const hoverSkin = skin || {
			weapon_id: weaponId,
			skin_id: "",
			chroma_id: null,
			buddy_id: null,
		};

		if (isPrimary) {
			// Large card for primary weapons (Vandal, Phantom, Operator)
			return (
				<div
					key={weaponId}
					className="group relative bg-linear-to-br from-card/80 to-card/40 rounded-lg p-2 cursor-pointer border border-border/20 hover:border-accent-cyan/40 transition-all duration-200 hover:scale-[1.02]"
					onMouseEnter={() => handleWeaponHover(hoverSkin)}
				>
					{/* Weapon type badge */}
					<div className="absolute top-1.5 left-2 z-10">
						<span className="text-[8px] font-bold uppercase tracking-wider text-accent-cyan/70">
							{weaponName}
						</span>
					</div>

					{/* Buddy indicator */}
					{hasBuddy && (
						<div className="absolute top-1.5 right-2 z-10">
							<div className="w-2 h-2 rounded-full bg-accent-gold/80 shadow-[0_0_6px_rgba(236,178,46,0.6)]" />
						</div>
					)}

					{/* Weapon image */}
					<div className="h-14 flex items-center justify-center mt-3">
						{icon && (
							<CachedImage
								src={icon}
								alt=""
								className={`max-w-full max-h-full object-contain drop-shadow-[0_2px_8px_rgba(0,0,0,0.5)] transition-all ${skin ? "group-hover:drop-shadow-[0_4px_12px_rgba(0,212,170,0.3)]" : "opacity-80"}`}
							/>
						)}
					</div>

					{/* Skin name */}
					<div className="mt-1.5 text-center">
						<div className="text-[9px] text-primary/90 font-medium truncate px-1">
							{skin ? meta?.name || "Standard" : "Standard"}
						</div>
					</div>
				</div>
			);
		}

		// Compact card for secondary/other weapons
		return (
			<div
				key={weaponId}
				className="group flex items-center gap-2 p-1.5 rounded-md cursor-pointer hover:bg-card/60 transition-all"
				onMouseEnter={() => handleWeaponHover(hoverSkin)}
			>
				<div className="w-12 h-7 flex items-center justify-center shrink-0">
					{icon && (
						<CachedImage
							src={icon}
							alt=""
							className={`max-w-full max-h-full object-contain transition-opacity ${skin ? "opacity-80 group-hover:opacity-100" : "opacity-60"}`}
						/>
					)}
				</div>
				<div className="flex-1 min-w-0">
					<div className="text-[8px] text-dim uppercase tracking-wide">
						{weaponName}
					</div>
					<div className="text-[9px] text-primary/80 truncate">
						{skin ? meta?.name || "Standard" : "Standard"}
					</div>
				</div>
				{hasBuddy && (
					<div className="w-1.5 h-1.5 rounded-full bg-accent-gold/60 shrink-0" />
				)}
			</div>
		);
	};

	const renderExpressionWheel = () => {
		if (expressions.length === 0) return null;
		const slotted = assignWheelSlots(expressions);

		return (
			<section>
				<div className="flex items-center gap-1.5 mb-1.5 px-1">
					<div className="w-1 h-3 bg-accent-gold/80 rounded-full" />
					<span className="text-[9px] font-bold uppercase tracking-wider text-accent-gold/80">
						{t("player.expressions")}
					</span>
				</div>

				<div className="relative mx-auto h-52 w-52">
					<div className="pointer-events-none absolute -inset-3 rounded-full bg-[radial-gradient(circle,rgba(0,212,170,0.14)_0%,rgba(236,178,46,0.06)_42%,transparent_70%)] blur-md" />

					<svg
						className="pointer-events-none absolute inset-0"
						viewBox="0 0 100 100"
						aria-hidden
					>
						<defs>
							<radialGradient id="exprWheelFill" cx="50%" cy="42%" r="58%">
								<stop offset="0%" stopColor="rgba(0,212,170,0.16)" />
								<stop offset="55%" stopColor="rgba(236,178,46,0.05)" />
								<stop offset="100%" stopColor="rgba(13,17,23,0.35)" />
							</radialGradient>
							<linearGradient id="exprWheelRing" x1="0" y1="0" x2="1" y2="1">
								<stop offset="0%" stopColor="rgba(0,212,170,0.75)" />
								<stop offset="50%" stopColor="rgba(236,178,46,0.55)" />
								<stop offset="100%" stopColor="rgba(0,212,170,0.7)" />
							</linearGradient>
							<linearGradient id="exprWheelX" x1="0" y1="0" x2="1" y2="1">
								<stop offset="0%" stopColor="rgba(236,178,46,0.08)" />
								<stop offset="50%" stopColor="rgba(236,178,46,0.45)" />
								<stop offset="100%" stopColor="rgba(0,212,170,0.12)" />
							</linearGradient>
						</defs>
						<circle cx="50" cy="50" r="47.5" fill="url(#exprWheelFill)" />
						<circle
							cx="50"
							cy="50"
							r="47.5"
							fill="none"
							stroke="url(#exprWheelRing)"
							strokeWidth="0.85"
						/>
						<circle
							cx="50"
							cy="50"
							r="45.6"
							fill="none"
							stroke="rgba(255,255,255,0.08)"
							strokeWidth="0.35"
						/>
						<line
							x1="16.5"
							y1="16.5"
							x2="83.5"
							y2="83.5"
							stroke="url(#exprWheelX)"
							strokeWidth="0.55"
						/>
						<line
							x1="83.5"
							y1="16.5"
							x2="16.5"
							y2="83.5"
							stroke="url(#exprWheelX)"
							strokeWidth="0.55"
						/>
						<circle
							cx="50"
							cy="50"
							r="10.5"
							fill="#0d1117"
							stroke="rgba(0,212,170,0.35)"
							strokeWidth="0.55"
						/>
						<circle
							cx="50"
							cy="50"
							r="3.2"
							fill="none"
							stroke="rgba(236,178,46,0.7)"
							strokeWidth="0.55"
						/>
					</svg>

					<div className="pointer-events-none absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border border-accent-gold/70 shadow-[0_0_8px_rgba(236,178,46,0.45)]" />

					{WHEEL_SLOT_ORDER.map((slot) => {
						const expr = slotted[slot];
						const info = expr
							? expressionMeta.get(expr.asset_id.toLowerCase())
							: undefined;
						return (
							<button
								key={slot}
								type="button"
								disabled={!expr}
								title={info?.name}
								aria-label={info?.name || slot}
								className={`group absolute ${WHEEL_SLOT_CLASS[slot]} flex h-16 w-16 items-center justify-center rounded-full bg-transparent transition-transform duration-200 ${
									expr
										? "cursor-pointer hover:scale-110"
										: "cursor-default opacity-30"
								}`}
								onMouseEnter={() => expr && handleExpressionHover(expr)}
							>
								<div className="pointer-events-none absolute inset-1 rounded-full bg-accent-cyan/0 opacity-0 blur-md transition-all duration-200 group-hover:bg-accent-cyan/25 group-hover:opacity-100" />
								<WheelIcon src={info?.icon} />
							</button>
						);
					})}
				</div>
			</section>
		);
	};

	return (
		<div className="flex flex-col h-full">
			{/* Player Header — card banner behind name/rank */}
			<div className="relative overflow-hidden border-b border-border/50">
				{cardBannerUrl && (
					<>
						<CachedImage
							src={cardBannerUrl}
							alt=""
							silent
							softOpacity={0.48}
							className="pointer-events-none absolute inset-0 h-full w-full object-cover object-[center_30%] select-none saturate-[0.85] brightness-95"
						/>
						{/* Left-heavy wash so name stays readable; right shows more art */}
						<div
							className="pointer-events-none absolute inset-0 bg-gradient-to-r from-[#0d1117]/92 via-[#0d1117]/55 to-[#0d1117]/30"
							aria-hidden
						/>
						<div
							className="pointer-events-none absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-[#0d1117]/70"
							aria-hidden
						/>
					</>
				)}
				{!cardBannerUrl && (
					<div className="absolute inset-0 bg-linear-to-b from-[#0d1117] to-transparent" />
				)}

				<div className="relative z-10 p-2.5">
					<div className="flex items-center gap-2.5">
						{agentIcon ? (
							<img
								src={agentIcon}
								alt=""
								className="w-10 h-10 rounded-full object-cover shrink-0"
								style={{
									boxShadow: `0 0 12px ${agentColor}40`,
									border: `2px solid ${agentColor}`,
								}}
							/>
						) : (
							<div className="w-10 h-10 rounded-full bg-card border border-border shrink-0" />
						)}
						<div className="flex-1 min-w-0">
							<div className="flex items-center gap-2">
								<button
									onClick={copyName}
									className="text-xs font-bold text-primary hover:text-accent-cyan transition-colors truncate text-left max-w-30 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)]"
								>
									{selectedPlayer.name}
								</button>

								{/* Recent Encounter Badge */}
								{selectedPlayer.previous_encounter && (
									<div
										className="px-1.5 py-0.5 rounded-[4px] bg-accent-cyan/10 border border-accent-cyan/30 flex items-center gap-1 shrink-0 animate-pulse backdrop-blur-[2px]"
										title={`${t(`player.recentEncounter${selectedPlayer.previous_encounter}`)}${selectedPlayer.previous_encounter_was_enemy ? t("player.encounterEnemySuffix") : ""}`}
									>
										<div className="w-1 h-1 rounded-full bg-accent-cyan" />
										<span className="text-[7px] font-bold text-accent-cyan uppercase tracking-tighter">
											{`${t(`player.recentEncounterShort${selectedPlayer.previous_encounter}`)}${selectedPlayer.previous_encounter_was_enemy ? t("player.encounterEnemySuffix") : ""}`}
										</span>
									</div>
								)}

								{/* Translate Button */}
								<button
									onClick={handleTranslate}
									className={`p-1 rounded-full transition-colors ${
										isTranslating
											? "text-accent-cyan cursor-wait"
											: translatedName === "Hata"
												? "text-accent-red hover:bg-card-hover/60"
												: translateDone
													? "text-success cursor-default"
													: "text-dim hover:text-accent-cyan hover:bg-card-hover/60"
									}`}
									title={
										translatedName === "Hata"
											? "Çeviri başarısız — tekrar dene"
											: translateDone
												? "Translated"
												: "Translate Name"
									}
								>
									{isTranslating ? (
										<svg
											className="w-3 h-3 animate-spin"
											viewBox="0 0 24 24"
											fill="none"
										>
											<circle
												className="opacity-25"
												cx="12"
												cy="12"
												r="10"
												stroke="currentColor"
												strokeWidth="4"
											></circle>
											<path
												className="opacity-75"
												fill="currentColor"
												d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
											></path>
										</svg>
									) : (
										<svg
											className="w-3 h-3"
											fill="none"
											viewBox="0 0 24 24"
											stroke="currentColor"
											strokeWidth="2"
										>
											<path
												strokeLinecap="round"
												strokeLinejoin="round"
												d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129"
											/>
										</svg>
									)}
								</button>
							</div>

							{translatedName ? (
								<div className="text-[10px] text-[#f5d78e] font-medium italic -mt-0.5 truncate drop-shadow-[0_1px_3px_rgba(0,0,0,0.95)]">
									{translatedName}
									{detectedLang && (
										<span className="not-italic text-[#f5d78e]/70 font-normal ml-1">
											({langDisplayName(detectedLang, locale)})
										</span>
									)}
								</div>
							) : null}

							{copied && (
								<span className="text-[8px] text-success block -mt-0.5">
									{t("player.copied")}
								</span>
							)}

							<div className="flex items-center gap-1.5 mt-0.5 drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]">
								{selectedPlayer.agent && (
									<span
										className="text-[9px] font-semibold"
										style={{ color: agentColor }}
									>
										{selectedPlayer.agent.charAt(0).toUpperCase() +
											selectedPlayer.agent.slice(1)}
									</span>
								)}
								{selectedPlayer.rank_tier > 0 && (
									<span
										className="text-[9px] font-medium"
										style={{ color: rankColor }}
									>
										{rankName}
									</span>
								)}

								{/* Peak Rank Compact Display */}
								{peakRank && peakRank.tier > selectedPlayer.rank_tier && (
									<>
										<span className="text-[8px] text-dim/50">•</span>
										<div
											className="flex items-center gap-1"
											title={`${t("player.peak")}: ${getLocalizedRank(peakRank.tier, locale)}`}
										>
											<span className="text-[8px] font-bold text-dim uppercase tracking-wider">
												{t("player.peak")}
											</span>
											<span
												className="text-[9px] font-bold"
												style={{ color: peakRank.rank_color }}
											>
												{getLocalizedRank(peakRank.tier, locale)}
											</span>
										</div>
									</>
								)}
							</div>
						</div>
					</div>
				</div>
			</div>

			{/* Skins Content */}
			<div
				className="flex-1 overflow-y-auto"
				onMouseLeave={() => setHoveredWeapon(null)}
			>
				{loading && (
					<div className="flex items-center justify-center py-8">
						<div className="w-5 h-5 border-2 border-accent-cyan border-t-transparent rounded-full animate-spin" />
					</div>
				)}

				{error && (
					<div className="text-center py-6 text-error text-[10px]">{error}</div>
				)}

				{!loading && !error && (skins.length > 0 || expressions.length > 0) && (
					<div className="p-2 space-y-3">
						{/* PRIMARY - Grid of large cards */}
						{skins.length > 0 && (
						<section>
							<div className="flex items-center gap-1.5 mb-1.5 px-1">
								<div className="w-1 h-3 bg-accent-cyan rounded-full" />
								<span className="text-[9px] font-bold uppercase tracking-wider text-accent-cyan/80">
									{t("weapons.primary")}
								</span>
							</div>
							<div className="grid grid-cols-2 gap-1.5">
								{WEAPON_CATEGORIES.primary.map((id) =>
									renderWeaponCard(id, true),
								)}
							</div>
						</section>
						)}

						{/* SECONDARY - Compact list */}
						{skins.length > 0 && (
						<section>
							<div className="flex items-center gap-1.5 mb-1 px-1">
								<div className="w-1 h-3 bg-accent-gold/70 rounded-full" />
								<span className="text-[9px] font-bold uppercase tracking-wider text-accent-gold/70">
									{t("weapons.secondary")}
								</span>
							</div>
							<div className="space-y-0.5">
								{WEAPON_CATEGORIES.secondary.map((id) => renderWeaponCard(id))}
							</div>
						</section>
						)}

						{/* OTHER - Compact list */}
						{skins.length > 0 && (
						<section>
							<div className="flex items-center gap-1.5 mb-1 px-1">
								<div className="w-1 h-3 bg-dim/50 rounded-full" />
								<span className="text-[9px] font-bold uppercase tracking-wider text-dim/70">
									{t("weapons.other")}
								</span>
							</div>
							<div className="space-y-0.5">
								{WEAPON_CATEGORIES.other.map((id) => renderWeaponCard(id))}
							</div>
						</section>
						)}

						{renderExpressionWheel()}
					</div>
				)}

				{!loading && !error && skins.length === 0 && expressions.length === 0 && (
					<div className="text-center py-6 text-dim text-[10px]">
						{t("player.noSkinData")}
					</div>
				)}
			</div>
		</div>
	);
}
