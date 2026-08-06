// Trello REST istemcisi (yalnizca OKUMA — eslestirme/backfill kaynak listesi).
// Anahtarlar .env.local'den: TRELLO_KEY, TRELLO_TOKEN, TRELLO_BOARD (shortLink).

export class TrelloError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "TrelloError";
    this.status = status;
  }
}

const BASE = "https://api.trello.com/1";

function creds(): { key: string; token: string } {
  const key = process.env.TRELLO_KEY;
  const token = process.env.TRELLO_TOKEN;
  if (!key || !token) throw new Error("TRELLO_KEY / TRELLO_TOKEN tanimli degil");
  return { key, token };
}

export async function trelloFetch<T = any>(
  pathname: string,
  params: Record<string, string> = {},
): Promise<T> {
  const { key, token } = creds();
  const qs = new URLSearchParams({ ...params, key, token });
  const res = await fetch(`${BASE}${pathname}?${qs}`, {
    signal: AbortSignal.timeout(15000),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new TrelloError(
      `Trello ${res.status} GET ${pathname}: ${text.slice(0, 200)}`,
      res.status,
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new TrelloError(`Trello JSON degil: ${text.slice(0, 200)}`);
  }
}

export interface TrelloCard {
  id: string;
  name: string;
  desc: string;
  due: string | null;
  dateLastActivity: string | null;
  idList: string;
  listName: string;
  labels: Array<{ name: string }>;
  memberNames: string[];
  /** Karttaki tum custom field text degerleri (e-posta arama havuzuna girer). */
  customTexts: string[];
  url: string;
}

// Board'daki acik kartlari liste adlariyla birlikte ceker.
export async function fetchBoardCards(board?: string): Promise<{
  boardName: string;
  cards: TrelloCard[];
}> {
  const boardId = board || process.env.TRELLO_BOARD;
  if (!boardId) throw new Error("TRELLO_BOARD tanimli degil");

  const info = await trelloFetch<{ name: string }>(`/boards/${boardId}`, {
    fields: "name",
  });
  const lists = await trelloFetch<Array<{ id: string; name: string }>>(
    `/boards/${boardId}/lists`,
    { fields: "name" },
  );
  const listName: Record<string, string> = {};
  for (const l of lists) listName[l.id] = l.name;

  const raw = await trelloFetch<any[]>(`/boards/${boardId}/cards`, {
    fields: "name,desc,due,dateLastActivity,idList,labels,url",
    members: "true",
    member_fields: "fullName,username",
    customFieldItems: "true",
  });

  const cards: TrelloCard[] = raw.map((c) => ({
    id: c.id,
    name: c.name || "",
    desc: c.desc || "",
    due: c.due || null,
    dateLastActivity: c.dateLastActivity || null,
    idList: c.idList,
    listName: listName[c.idList] || "?",
    labels: (c.labels || []).map((l: any) => ({ name: l?.name || "" })),
    memberNames: (c.members || [])
      .map((m: any) => m?.fullName || m?.username || "")
      .filter(Boolean),
    customTexts: (c.customFieldItems || [])
      .map((f: any) => f?.value?.text || f?.value?.number || "")
      .map(String)
      .filter(Boolean),
    url: c.url || "",
  }));

  return { boardName: info.name, cards };
}
