import type { Config } from "@netlify/functions";
import webpush from "web-push";

// ═══════ CONFIG ═══════

const FIREBASE_DB_URL =
  "https://la-table-familiale-default-rtdb.europe-west1.firebasedatabase.app";
const FAMILY_ID = "madateam";

// Catégories d'ingrédients considérés comme "frais"
const FRESH_KEYWORDS = [
  // Légumes
  "salade", "tomate", "concombre", "avocat", "courgette", "aubergine",
  "poivron", "épinard", "poireau", "brocoli", "chou", "carotte",
  "oignon", "champignon", "fenouil", "radis", "navet", "céleri",
  "asperge", "artichaut", "haricot vert", "petit pois", "maïs",
  "betterave", "endive", "cresson", "roquette", "mâche", "laitue",
  "ciboulette", "persil", "basilic", "menthe", "coriandre", "aneth",
  "romarin", "thym", "estragon", "patate douce", "butternut", "potimarron",
  // Fruits
  "mangue", "pêche", "poire", "pomme", "pastèque", "melon",
  "fraise", "framboise", "myrtille", "citron", "orange", "banane",
  "kiwi", "raisin", "abricot", "cerise", "figue", "grenade",
  "pamplemousse", "clémentine", "nectarine", "prune",
  // Frais (rayon frais)
  "crème fraîche", "crème", "fêta", "feta", "mozzarella", "chèvre",
  "ricotta", "mascarpone", "parmesan", "gruyère", "emmental",
  "comté", "beaufort", "reblochon", "roquefort", "camembert", "brie",
  "fromage", "lait", "yaourt", "beurre", "œuf", "oeuf",
  "pain", "pâte feuilletée", "pâte brisée", "pâte à pizza",
  "tortilla", "naan", "galette", "crêpe",
  "tofu", "houmous",
  // Protéines fraîches
  "poulet", "saumon", "truite", "crevette", "cabillaud", "thon frais",
  "maquereau", "sardine", "gambas", "noix de saint-jacques",
  "poisson", "filet",
];

// ═══════ HELPERS ═══════

/** Lire une clé Firebase via l'API REST */
async function firebaseGet(key: string): Promise<any> {
  const url = `${FIREBASE_DB_URL}/${FAMILY_ID}/${key}.json`;
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.json();
}

/** Vérifier si un ingrédient est "frais" */
function isFresh(ingredientName: string): boolean {
  const lower = ingredientName.toLowerCase();
  return FRESH_KEYWORDS.some((kw) => lower.includes(kw));
}

/** Récupérer toutes les subscriptions push */
async function getSubscriptions(): Promise<webpush.PushSubscription[]> {
  const subs = await firebaseGet("push_subscriptions");
  if (!subs) return [];
  return Object.values(subs).filter(
    (s: any) => s && s.endpoint
  ) as webpush.PushSubscription[];
}

/** Envoyer une notification à toutes les subscriptions */
async function sendToAll(
  title: string,
  body: string,
  tag: string
): Promise<number> {
  const subs = await getSubscriptions();
  if (subs.length === 0) {
    console.log("Aucune subscription push trouvée");
    return 0;
  }

  const payload = JSON.stringify({ title, body, tag, url: "/" });
  let sent = 0;

  for (const sub of subs) {
    try {
      await webpush.sendNotification(sub, payload);
      sent++;
    } catch (err: any) {
      console.warn(`Erreur envoi push: ${err.statusCode || err.message}`);
      // Si subscription expirée (410 Gone), on pourrait la supprimer
      if (err.statusCode === 410) {
        console.log("Subscription expirée, à nettoyer");
      }
    }
  }

  return sent;
}

/** Obtenir l'heure de Paris (fuseau Europe/Paris) */
function getParisTime(): { hour: number; minute: number; dayOfWeek: number } {
  const now = new Date();
  const paris = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    hour: "numeric",
    minute: "numeric",
    weekday: "long",
  }).formatToParts(now);

  const hour = parseInt(paris.find((p) => p.type === "hour")?.value || "0");
  const minute = parseInt(paris.find((p) => p.type === "minute")?.value || "0");
  const weekdayName = paris.find((p) => p.type === "weekday")?.value || "";

  const dayMap: Record<string, number> = {
    lundi: 1, mardi: 2, mercredi: 3, jeudi: 4,
    vendredi: 5, samedi: 6, dimanche: 0,
  };

  return { hour, minute, dayOfWeek: dayMap[weekdayName] ?? -1 };
}

// ═══════ LES 3 NOTIFICATIONS ═══════

/** 🧊 Notification achats frais — Jeudi 9h */
async function handleAchatsFrais(): Promise<void> {
  const menu = await firebaseGet("ltf2_menu");
  const locked = await firebaseGet("ltf2_lock");

  if (!locked || !menu?.repas) {
    console.log("🧊 Menu non verrouillé ou vide, skip");
    return;
  }

  // Ingrédients des repas fin de semaine (jourIdx >= 3 = Jeudi à Dimanche)
  const freshIngredients = new Set<string>();

  // Ingrédients déjà dans les repas début de semaine (pas besoin de les racheter)
  const earlyWeekIngredients = new Set<string>();

  for (const repas of menu.repas) {
    if (!repas.ingredients) continue;
    const idx = repas.jourIdx ?? 0;

    for (const ing of repas.ingredients) {
      const name = ing[0];
      if (idx < 3) {
        earlyWeekIngredients.add(name.toLowerCase());
      } else if (isFresh(name)) {
        freshIngredients.add(name);
      }
    }
  }

  // Retirer les ingrédients frais déjà achetés en début de semaine
  const finalList: string[] = [];
  for (const name of freshIngredients) {
    if (!earlyWeekIngredients.has(name.toLowerCase())) {
      finalList.push(name);
    }
  }

  if (finalList.length === 0) {
    console.log("🧊 Pas d'ingrédients frais à acheter");
    return;
  }

  const body = `Achats frais cette semaine :\n${finalList.join(", ")}`;
  const sent = await sendToAll("🧊 Achats frais", body, "achats-frais");
  console.log(`🧊 Notification achats frais envoyée à ${sent} appareil(s)`);
}

/** 👨‍🍳 Notification batch cooking — Dimanche 9h */
async function handleBatchCooking(): Promise<void> {
  const menu = await firebaseGet("ltf2_menu");
  const locked = await firebaseGet("ltf2_lock");

  if (!locked || !menu?.repas) {
    console.log("👨‍🍳 Menu non verrouillé ou vide, skip");
    return;
  }

  const batchPlats = menu.repas.filter(
    (r: any) => r.batch === "Oui" || r.batch === "Partiel"
  );

  if (batchPlats.length === 0) {
    console.log("👨‍🍳 Aucun plat batch cette semaine");
    return;
  }

  const names = batchPlats.map((r: any) => r.nom).join(", ");
  const body = `Batch cooking aujourd'hui :\n${names}`;
  const sent = await sendToAll("👨‍🍳 Batch cooking", body, "batch-cooking");
  console.log(`👨‍🍳 Notification batch envoyée à ${sent} appareil(s)`);
}

/** ⏰ Notification cuisson longue — Le soir */
async function handleCuissonLongue(
  parisHour: number,
  parisMinute: number,
  dayOfWeek: number
): Promise<void> {
  const menu = await firebaseGet("ltf2_menu");
  const locked = await firebaseGet("ltf2_lock");

  if (!locked || !menu?.repas) return;

  // Mapper jour de la semaine → jourIdx du menu
  // Le menu commence au jour de génération, mais les jours sont Lundi=0 ... Dimanche=6
  // On cherche le repas dont le jourIdx correspond au jour actuel
  const jourNames = ["dimanche", "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi"];
  const todayName = jourNames[dayOfWeek]?.toLowerCase();

  const todayRepas = menu.repas.find((r: any) => {
    const jourShort = (r.jourShort || r.jour || "").toLowerCase();
    return jourShort.startsWith(todayName);
  });

  if (!todayRepas) return;

  const tempsPrepa = todayRepas.temps_prepa || 0;
  if (tempsPrepa <= 25) return; // Pas de notif pour les plats rapides

  // Heure de lancement = 19h45 - temps de cuisson
  // Convertir en minutes depuis minuit pour comparer
  const targetMinutes = 19 * 60 + 45 - tempsPrepa;
  const currentMinutes = parisHour * 60 + parisMinute;

  // On vérifie toutes les heures, donc on accepte une fenêtre de ±30 min
  if (Math.abs(currentMinutes - targetMinutes) <= 30) {
    const heureL = Math.floor(targetMinutes / 60);
    const minL = targetMinutes % 60;
    const heureLStr = `${heureL}h${minL.toString().padStart(2, "0")}`;
    const body = `Lancer "${todayRepas.nom}" maintenant (${tempsPrepa} min de cuisson) pour manger à 19h45`;
    const sent = await sendToAll(
      `⏰ ${todayRepas.nom}`,
      body,
      "cuisson-longue"
    );
    console.log(`⏰ Notification cuisson longue envoyée à ${sent} appareil(s)`);
  }
}

// ═══════ HANDLER PRINCIPAL ═══════

export default async function handler() {
  // Config VAPID
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const email = process.env.VAPID_EMAIL || "mailto:contact@example.com";

  if (!publicKey || !privateKey) {
    console.error("❌ Clés VAPID manquantes dans les variables d'environnement");
    return new Response("VAPID keys missing", { status: 500 });
  }

  webpush.setVapidDetails(email, publicKey, privateKey);

  const { hour, minute, dayOfWeek } = getParisTime();
  console.log(
    `⏱️ Heure Paris: ${hour}h${minute.toString().padStart(2, "0")}, jour: ${dayOfWeek}`
  );

  try {
    // 🧊 Jeudi 9h → Achats frais
    if (dayOfWeek === 4 && hour === 9) {
      await handleAchatsFrais();
    }

    // 👨‍🍳 Dimanche 9h → Batch cooking
    if (dayOfWeek === 0 && hour === 9) {
      await handleBatchCooking();
    }

    // ⏰ Tous les soirs (17h-20h) → Cuisson longue
    if (hour >= 17 && hour <= 20) {
      await handleCuissonLongue(hour, minute, dayOfWeek);
    }
  } catch (err) {
    console.error("❌ Erreur dans send-notifications:", err);
    return new Response("Error", { status: 500 });
  }

  return new Response(`OK — ${hour}h${minute.toString().padStart(2, "0")}`, {
    status: 200,
  });
}

// Exécuter toutes les heures
export const config: Config = {
  schedule: "0 * * * *",
};
