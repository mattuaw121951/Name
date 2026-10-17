import { and, desc, eq, ne, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import { mackGuildSettings, mackMessages } from "@workspace/db/schema";

export type MemoryEntry = typeof mackMessages.$inferSelect;

export async function isGuildActive(guildId: string): Promise<boolean> {
  const [settings] = await db
    .select({ active: mackGuildSettings.active })
    .from(mackGuildSettings)
    .where(eq(mackGuildSettings.guildId, guildId))
    .limit(1);

  return settings?.active ?? false;
}

export async function setGuildActive(
  guildId: string,
  active: boolean,
): Promise<void> {
  await db
    .insert(mackGuildSettings)
    .values({ guildId, active })
    .onConflictDoUpdate({
      target: mackGuildSettings.guildId,
      set: { active, updatedAt: new Date() },
    });
}

export async function saveMemory(entry: MemoryEntry): Promise<void> {
  await db.insert(mackMessages).values(entry).onConflictDoNothing();
}

function searchableTerms(content: string): string {
  const ignored = new Set([
    "about",
    "after",
    "again",
    "because",
    "could",
    "from",
    "have",
    "just",
    "that",
    "them",
    "then",
    "there",
    "these",
    "they",
    "this",
    "those",
    "what",
    "when",
    "where",
    "which",
    "with",
    "would",
    "your",
  ]);

  return content
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((term) => term.length > 2 && !ignored.has(term))
    .slice(0, 12)
    .join(" ");
}

export async function loadMemory(
  guildId: string,
  channelId: string,
  currentMessageId: string,
  currentContent: string,
): Promise<MemoryEntry[]> {
  const channelScope = and(
    eq(mackMessages.guildId, guildId),
    eq(mackMessages.channelId, channelId),
  );

  const recent = await db
    .select()
    .from(mackMessages)
    .where(channelScope)
    .orderBy(desc(mackMessages.createdAt))
    .limit(18);

  const terms = searchableTerms(currentContent);
  const related =
    terms.length > 0
      ? await db
          .select()
          .from(mackMessages)
          .where(
            and(
              eq(mackMessages.guildId, guildId),
              eq(mackMessages.channelId, channelId),
              ne(mackMessages.id, currentMessageId),
              sql`to_tsvector('simple', ${mackMessages.content}) @@ plainto_tsquery('simple', ${terms})`,
            ),
          )
          .orderBy(
            desc(
              sql`ts_rank(to_tsvector('simple', ${mackMessages.content}), plainto_tsquery('simple', ${terms}))`,
            ),
            desc(mackMessages.createdAt),
          )
          .limit(6)
      : [];

  const unique = new Map<string, MemoryEntry>();
  for (const entry of [...related, ...recent]) {
    unique.set(entry.id, entry);
  }

  return [...unique.values()]
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
    .slice(-24);
}
