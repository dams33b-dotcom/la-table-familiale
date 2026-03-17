import type { Config } from "@netlify/functions";
import webpush from "web-push";

// ═══════ CONFIG ═══════

const FIREBASE_DB_URL =
  "https://la-table-familiale-default-rtdb.europe-west1.firebasedatabase.app";
const FAMILY_ID = "madateam";

// Catégories d'ingrédients considérés comme "frais"
const FRESH_KEYWORDS = [
  "salade", "tomate", "concombre", "avocat", "courgette", "aubergine",
  "poivron", "épinard", "poireau", "brocoli", "chou", "carotte",
  "oignon", "champignon", "fenouil", "radis", "navet", "céleri",
  "asperge", "artichaut", "haricot vert", "petit pois", "maïs",
  "betterave", "endive", "cresson", "roquette", "mâche", "laitue",
  "ciboulette", "persil", "basilic", "menthe", "coriandre", "aneth",
  "romarin", "thym", "estragon", "patate douce", "butternut", "potimarron",
  "mangue", "pêche", "poire", "pomme", "pastèque", "melon",
  "fraise", "framboise", "myrtille", "citron", "orange", "banane",
  "kiwi", "raisin", "abricot", "cerise", "figue", "grenade",
  "pamplemousse", "clémentine", "nectarine", "prune",
  "crème fraîche", "crème", "fêta", "feta", "mozzarella", "chèvre",
  "ricotta", "mascarpone", "parmesan", "gruyère", "emmental",
  "comté", "beaufort", "reblochon", "roquefort", "camembert", "brie",
  "fromage", "lait", "yaourt", "beurre", "œuf", "oeuf",
  "pain", "pâte feuilletée", "pâte brisée", "pâte à pizza",
  "tortilla", "naan", "galette", "crêpe", "tofu", "houmous",
  "poulet", "saumon", "truite", "crevette", "cabillaud", "thon frais",
  "maquereau", "sardine", "gambas", "noix de saint-jacques",
  "poisson", "filet",
];

// ═══════ HELPERS ═══════

async function firebaseGet(key: string): Promise<any> {
  const url = `${FIREBASE_DB_URL}/${FAMILY_ID}/${key}.json`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

async function firebaseSet(key: string, value: any): Promise<void> {
  const url = `${FIREBASE_DB_URL}/${FAMILY_ID}/${key}.json`;
  await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
}

function isFresh(ingredientName: string): boolean {
  const lower = ingredientName.toLowerCase();
  return FRESH_KEYWORDS.some((kw) => lower.includes(kw));
}

async function getSubscriptions(): Promise<webpush.PushSubscription[]> {
  const subs = await firebaseGet("push_subscriptions");
  if (!subs) return [];
  return Object.values(subs).filter(
    (s: any) => s && s.endpoint
  ) as webpush.PushSubscription[];
}

async function sendToAll(title: string, body: string, tag: string): Promise<number> {
  const subs = await getSubscriptions();
  if (subs.length === 0) { console.log("Aucune subscription"); return 0; }

  const payload = JSON.stringify({ title, body, tag, url: "/" });
  let sent = 0;

  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload);
      sent++;
    } catch (err: any) {
      console.warn(`Push error: ${err.statusCode || err.message}`);
    }
  }
  return sent;
}

function getParisDate(): Date {
  const now = new Date();
  const parisStr = now.toLocaleString("en-US", { timeZone: "Europe/Paris" });
  return new Date(parisStr);
}

function daysDiff(d1: Date, d2: Date): number {
  const date1 = new Date(d1.getFullYear(), d1.getMonth(), d1.getDate());
  const date2 = new Date(d2.getFullYear(), d2.getMonth(), d2.getDate());
  return Math.round((date2.getTime() - date1.getTime()) / (86400000));
}

function hoursDiff(d1: Date, d2: Date): number {
  return (d2.getTime() - d1.getTime()) / (3600000);
}

// Anti-doublon : vérifier/marquer les notifs envoyées
async function wasAlreadySent(notifKey: string): Promise<boolean> {
  const sent = await firebaseGet("push_sent/" + notifKey);
  return !!sent;
}

async function markAsSent(notifKey: string): Promise<void> {
  await firebaseSet("push_sent/" + notifKey, new Date().toISOString());
}

// ═══════ NOTIFICATION 1 — 🧊 ACHATS FRAIS (J+4 après verrouillage, 9h) ═══════

async function handleAchatsFrais(parisNow: Date, lockDate: Date, menu: any): Promise<void> {
  const daysSinceLock = daysDiff(lockDate, parisNow);
  if (daysSinceLock !== 4 || parisNow.getHours() !== 9) return;

  const notifKey = `frais_${lockDate.toISOString().slice(0, 10)}`;
  if (await wasAlreadySent(notifKey)) return;

  const freshIngredients = new Set<string>();
  const earlyWeekIngredients = new Set<string>();

  for (const repas of menu.repas || []) {
    if (!repas.ingredients) continue;
    const idx = repas.jourIdx ?? 0;
    for (const ing of repas.ingredients) {
      const name = ing[0];
      if (idx < 3) earlyWeekIngredients.add(name.toLowerCase());
      else if (isFresh(name)) freshIngredients.add(name);
    }
  }

  const finalList: string[] = [];
  for (const name of freshIngredients) {
    if (!earlyWeekIngredients.has(name.toLowerCase())) finalList.push(name);
  }

  if (finalList.length === 0) { console.log("🧊 Aucun ingrédient frais"); return; }

  const body = `Achats frais à faire :\n${finalList.join(", ")}`;
  const sent = await sendToAll("🧊 Achats frais", body, "achats-frais");
  if (sent > 0) await markAsSent(notifKey);
  console.log(`🧊 Envoyé à ${sent} appareil(s)`);
}

// ═══════ NOTIFICATION 2 — 👨‍🍳 BATCH COOKING (3h après lock + J+1 à 9h) ═══════

async function handleBatchCooking(parisNow: Date, lockDate: Date, menu: any): Promise<void> {
  const batchPlats = (menu.repas || []).filter(
    (r: any) => r.batch === "Oui" || r.batch === "Partiel"
  );
  if (batchPlats.length === 0) return;

  const names = batchPlats.map((r: any) => r.nom).join(", ");

  // Alerte 1 : 3h après verrouillage
  const hoursAfterLock = hoursDiff(lockDate, parisNow);
  const notifKey1 = `batch3h_${lockDate.toISOString().slice(0, 16)}`;

  if (hoursAfterLock >= 3 && hoursAfterLock < 4) {
    if (!(await wasAlreadySent(notifKey1))) {
      const body = `Batch cooking à préparer :\n${names}`;
      const sent = await sendToAll("👨‍🍳 Batch cooking", body, "batch-3h");
      if (sent > 0) await markAsSent(notifKey1);
      console.log(`👨‍🍳 Batch 3h: ${sent} appareil(s)`);
    }
  }

  // Alerte 2 : Lendemain à 9h
  const daysSinceLock = daysDiff(lockDate, parisNow);
  const notifKey2 = `batchJ1_${lockDate.toISOString().slice(0, 10)}`;

  if (daysSinceLock === 1 && parisNow.getHours() === 9) {
    if (!(await wasAlreadySent(notifKey2))) {
      const body = `Rappel batch cooking aujourd'hui :\n${names}`;
      const sent = await sendToAll("👨‍🍳 Batch — rappel", body, "batch-j1");
      if (sent > 0) await markAsSent(notifKey2);
      console.log(`👨‍🍳 Batch J+1: ${sent} appareil(s)`);
    }
  }
}

// ═══════ NOTIFICATION 3 — ⏰ CUISSON LONGUE (tous les jours à 18h) ═══════

async function handleCuissonLongue(parisNow: Date, menu: any): Promise<void> {
  if (parisNow.getHours() !== 18) return;

  const jourNames = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
  const todayName = jourNames[parisNow.getDay()];

  const todayRepas = (menu.repas || []).find((r: any) => {
    const js = (r.jourShort || r.jour || "").toLowerCase();
    return js.startsWith(todayName);
  });

  if (!todayRepas) return;
  const tempsPrepa = todayRepas.temps_prepa || 0;
  if (tempsPrepa <= 25) return;

  const todayStr = parisNow.toISOString().slice(0, 10);
  const notifKey = `cuisson_${todayStr}`;
  if (await wasAlreadySent(notifKey)) return;

  const body = `"${todayRepas.nom}" prend ${tempsPrepa} min — pensez à lancer la préparation !`;
  const sent = await sendToAll(`⏰ ${todayRepas.nom}`, body, "cuisson-longue");
  if (sent > 0) await markAsSent(notifKey);
  console.log(`⏰ Cuisson: ${sent} appareil(s)`);
}

// ═══════ HANDLER PRINCIPAL ═══════

export default async function handler() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const email = process.env.VAPID_EMAIL || "mailto:contact@example.com";

  if (!publicKey || !privateKey) {
    console.error("❌ Clés VAPID manquantes");
    return new Response("VAPID keys missing", { status: 500 });
  }

  webpush.setVapidDetails(email, publicKey, privateKey);

  const parisNow = getParisDate();
  const hour = parisNow.getHours();
  const minute = parisNow.getMinutes();
  const dayName = parisNow.toLocaleDateString("fr-FR", { weekday: "long" });
  console.log(`⏱️ Paris: ${dayName} ${hour}h${String(minute).padStart(2, "0")}`);

  const locked = await firebaseGet("ltf2_lock");
  if (!locked) {
    console.log("🔓 Menu non verrouillé");
    return new Response("Not locked", { status: 200 });
  }

  const menu = await firebaseGet("ltf2_menu");
  if (!menu?.repas) {
    console.log("📭 Pas de menu");
    return new Response("No menu", { status: 200 });
  }

  // Date de verrouillage
  const lockAtStr = await firebaseGet("ltf2_lock_at");
  const lockDate = lockAtStr
    ? new Date(new Date(lockAtStr).toLocaleString("en-US", { timeZone: "Europe/Paris" }))
    : new Date(new Date(menu.at || menu.startDate || Date.now()).toLocaleString("en-US", { timeZone: "Europe/Paris" }));

  console.log(`🔒 Verrouillé le: ${lockDate.toLocaleDateString("fr-FR")} ${lockDate.getHours()}h`);

  try {
    await handleAchatsFrais(parisNow, lockDate, menu);
    await handleBatchCooking(parisNow, lockDate, menu);
    await handleCuissonLongue(parisNow, menu);
  } catch (err) {
    console.error("❌ Erreur:", err);
    return new Response("Error", { status: 500 });
  }

  return new Response(`OK — ${dayName} ${hour}h${String(minute).padStart(2, "0")}`, { status: 200 });
}

export const config: Config = {
  schedule: "0 * * * *",
};
