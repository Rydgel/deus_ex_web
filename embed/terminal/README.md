# X embed: the UNATCO terminal

A fan-made puzzle game in an X (Twitter) **player card**: a UNATCO network
terminal with the original login and e-mail screens. Players find logins in
the e-mails and in replies to the post, and each login opens the next
account's mail.

The screens are rebuilt from the original data: `DeusEx.u` class defaults and
script constants for layout, `DeusExUI.u` textures and bitmap fonts,
`DeusEx.int` for strings and the UNATCO node. It is a showcase beside the
browser runtime, not part of it.

## Build

```sh
node embed/terminal/build.mjs --url https://your-host.example/path/
```

- Writes a static site to `embed/terminal/out/` (ignored by Git: it holds
  original textures and fonts).
- `--url` is the absolute HTTPS address the site will be served from, and
  also renders the card image. `--poster` renders the image for a local build.

Preview it locally:

```sh
node embed/serve.mjs 5181 embed/terminal/out
```

Then open `http://127.0.0.1:5181/`.

Deployed at `https://unatco-terminal.pages.dev/` (Cloudflare Pages project
`unatco-terminal`). To update it:

```sh
node embed/terminal/build.mjs --url https://unatco-terminal.pages.dev/
wrangler pages deploy embed/terminal/out --project-name unatco-terminal --branch main --commit-dirty=true
```

X caches a card the first time it sees a URL, so a changed poster or title
needs a new URL (for example `?v=2`) to show up in new posts.

## The story

[story.mjs](story.mjs) holds the accounts and their e-mails, and lists where
each login is meant to be found. The build seals every account's mail with
AES-GCM under a PBKDF2 key derived from its login, uppercased because
`ComputerScreenLogin.ProcessLogin` compares `Caps()` of both. The published
files therefore contain neither the logins nor the text, but `story.mjs`
does: keep the repository private, or move the file out, before it goes
public.

Write mail in plain ASCII. The menu fonts cover Latin-1 only.

## Original and approximated

| Part | Source |
| --- | --- |
| Window layout: title, client, button bar, status | `ComputerUIWindow` (`CreateClientWindow`, `ConfigurationChanged`), `MenuUIActionButtonBarWindow.ConfigurationChanged` |
| Login screen: labels, edit fields in info buttons, logo, info line, Login/Cancel | `ComputerScreenLogin.CreateControls` and its constants |
| Login rules: both fields needed, failure message, fields cleared | `ComputerScreenLogin.EnableButtons`, `ProcessLogin` |
| E-mail screen: header buttons, list, From/To/Subj/CC, body, Logout | `ComputerScreenEmail.CreateControls` and its constants |
| Status line `Daedalus:GlobalNode:<address>/<function>` | `ComputerUIWindow.SetCompOwner` |
| Textures, draw styles and tints | Each window's `DrawWindow` (masked, tinted by `ColorThemeMenu_Default`) |
| Fonts | The original `UFont` pages and glyph rectangles |
| Text layout and word wrap | Approximation: left-to-right glyph advance, greedy wrap at spaces |
| `\|&` accelerator markers in button labels | Removed; whether the original underlines the letter is unverified |
| List row height, column padding, selection colours | Approximation from the theme colours |
| Scroll bars | Not drawn; the body scrolls with the wheel and shows a thin indicator |
| E-mail order | As written in `story.mjs`, not sorted by sender |
| Menu sounds | Not included |
