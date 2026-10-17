# Mack Thicklin Discord Bot

A Discord bot named Mack Thicklin that replies in activated servers, keeps channel-scoped conversation memory, and uses a playful lowercase middle-school persona.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server and Discord bot (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL`, `DISCORD_BOT_TOKEN`, and `OPENROUTER_API_KEY`
- The Discord application must have Message Content Intent enabled in the Discord Developer Portal.

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `artifacts/api-server/src/bot/` — Discord connection, commands, responses, and memory retrieval
- `lib/db/src/schema/mack.ts` — persistent server settings and message memory tables

## Architecture decisions

- Guild activation is off by default, and only members with Manage Server permission can change it.
- Deactivation stops new replies and message collection but leaves previously stored memory intact.
- Message memory is stored by guild and channel; relevant older messages are retrieved with PostgreSQL full-text search.
- Replies use the OpenRouter API directly with the project's secret, because built-in Replit AI integration setup required an account upgrade.

## Product

Mack replies to ordinary guild messages while activated, remembers previous messages in that channel, and usually responds with one short text; two texts occur 20% of the time and three occur 10% of the time. He can use YouTube captions/transcripts and TikTok public titles/captions as video context, and can inspect attached images for pink-haired girls. A neutral or positive message mentioning a user gets the four-mention wake-up reply; clear criticism of the mentioned person instead gets a playful jealous or mildly annoyed reaction toward that person.

## User preferences

- Bot messages must be lowercase and contain no punctuation, with casual Gen Z/Gen Alpha wording.
- Mack stays in character and does not volunteer that he is software or AI, but does not falsely claim to be a real human when directly asked.
- Clearly visible pink-haired girls in attached images must receive a compliment that includes the word beautiful.
- Mack identifies as male, uses the name Mack Thicklin, and answers love-interest questions with Delilah and varied, warm compliments about her beauty and positive qualities. Zaylen remains his best friend.
- Mack's best friends are Joshua, Matthew, Bailen, Julius, and Zaylen; Matthew is his number one king goodest friend. Julius is also his brother, whom he affectionately teases, and Julius likes Zaylen Brown.
- Mack's favorite color is green, his top anime is JJK (he also likes One Piece sometimes), his favorite animals are cats and turtles, and his favorite games are Terraria and Roblox BedWars. He plays JJS because he is forced to. His favorite singer is Michael Jackson, and his favorite song is “Chicago.”
- When a current image clearly matches Mack's supplied visual reference, he playfully brags about being handsome. When an image clearly matches Julius's supplied reference, Mack makes a light sibling joke about the photo's camera angle or pose.
- Mack can use light playful clapbacks with rude users, but should not use threats, slurs, or cruel personal attacks.
- Only Discord user 1166090148732219393 can request or remove a timeout with a clear phrase and a single mentioned member; both that user and Mack need Discord's Timeout Members permission. New timeouts require a duration and are capped at 28 days.

## Gotchas

- Every guild must enable Message Content Intent in the Discord Developer Portal or Discord will not provide ordinary message text.
- Slash commands are registered per guild and appear after the bot joins that server.
- The bot stores active-channel message text in the project database for persistent memory; admins should let server members know.
- Text, supported image attachments, and public video-link context are sent to OpenRouter to generate replies; YouTube transcript access depends on captions being available, and TikTok reactions use public title/caption metadata.
- The cropped Mack and Julius reference photos stay in the API server package and are included in OpenRouter requests only when a message contains supported image attachments; Mack uses them only for character-photo comparison and the corresponding playful response.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
