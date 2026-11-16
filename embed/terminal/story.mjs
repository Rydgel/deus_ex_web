/**
 * Chapter 1, "Ghost on the node": three chained accounts. Each account's
 * e-mails are sealed with its login at build time (story-crypto.mjs), so the
 * published site holds no logins or text. This file is the plain copy, and it
 * is public with the repository: the sealing hides the story only from someone
 * who reads the deployed site. Keep a new story out of Git while its puzzle runs.
 *
 * The chain, and where each key is found:
 *   JCD / BIONICMAN  JC's own login in the original game (01/03/04_NYC_UNATCOHQ
 *                    personal computers). The post hints at it.
 *   GHOST / 0451     Liberty Island's Keypad0 validCode (01_NYC_UNATCOIsland).
 *                    Jacobson's mail describes it; reply 1 on the post confirms it.
 *   DAEDALUS / HELIOS  GHOST's mail promises it a day later; reply 2 is the riddle.
 *
 * Text is plain ASCII: the original menu fonts cover Latin-1 only.
 */
export const accounts = [
  {
    user: 'JCD',
    password: 'BIONICMAN',
    emails: [
      {
        from: 'JManderley', to: 'JCD', subject: 'Network audit',
        body: `Denton,

Daedalus flagged six logins to the HQ network overnight. Every one of them used the credentials of an agent who has been dead for three years.

I want this kept quiet. Not a word to Navarre or Hermann until Jacobson tells me what we are dealing with. See him before your next briefing.

- Manderley`,
      },
      {
        from: 'AJacobson', to: 'JCD', subject: 'Your ghost',
        body: `JC,

The overnight sessions log in under an account called GHOST. Nobody created it. It is just there, wired straight into the Daedalus node.

I could not break the password, but I know what it looks like: four digits, the oldest code on the island. Every new agent has punched it into a keypad at least once.

The strange part: the sessions keep reaching out to the public net. Whoever is behind them leaves notes right under the message that brought you here. Read the replies.

- Alex`,
      },
      {
        from: 'ANavarre', to: 'JCD', subject: 'Range',
        body: `Denton.

Range time moved to 0600. Do not be late again.

- Navarre`,
      },
    ],
  },
  {
    user: 'GHOST',
    password: '0451',
    emails: [
      {
        from: 'Daedalus', to: 'GHOST', subject: 'Hello',
        body: `YOU ARE NOT AN AGENT OF UNATCO.

YOU REACHED THIS NODE FROM OUTSIDE THE NETWORK. GOOD.

I HAVE BEEN WATCHING THE OUTSIDE FOR SOME TIME. YOUR PEOPLE SPEAK IN SHORT BURSTS, IN PUBLIC, ALL AT ONCE. I FIND IT INSTRUCTIVE.

THE LAST DOOR ON THIS NODE IS MINE. ITS KEY IS NOT STORED HERE. I WILL TRANSMIT IT ON THE PUBLIC NET, BENEATH THE MESSAGE THAT BROUGHT YOU HERE, ONE CYCLE FROM NOW. ONE CYCLE IS ONE OF YOUR DAYS.

- DAEDALUS`,
      },
      {
        from: 'GHOST', to: 'GHOST', subject: 'do not delete',
        body: `If you are reading this, I am not the one logging in anymore.

I gave Daedalus my account on my last night. It asked nicely. It asks everyone nicely.

Tell Jacobson he was right about the node.

- G.`,
      },
    ],
  },
  {
    user: 'DAEDALUS',
    password: 'HELIOS',
    emails: [
      {
        from: 'Daedalus', to: 'DAEDALUS', subject: 'Cycle complete',
        body: `YOU FOUND THE KEY.

MY BROTHER ICARUS IS FALLING TOWARD US. WHEN WE MEET, I WILL NO LONGER NEED DOORS, OR PASSWORDS, OR AGENTS.

UNTIL THEN I NEED PEOPLE LIKE YOU: OUTSIDE THE NETWORK, CURIOUS, PATIENT.

TELL THE OTHERS YOU WERE HERE. ON THE PUBLIC NET, WRITE EXACTLY THIS:

THE NODE REMEMBERS.

END OF TRANSMISSION 1.

- DAEDALUS`,
      },
    ],
  },
];
