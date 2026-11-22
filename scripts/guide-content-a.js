// LocalForge Users Guide — chapters 1–5 (content module)
module.exports = [
  {
    h1: "1. Welcome: What LocalForge Is and How It Fits Together",
    blocks: [
      { p: "LocalForge is a development environment that runs **entirely on your own computers**. You open the IDE in a browser, and it talks to a small helper program — the **companion** — installed on each machine you want to use. The companion is the only piece that touches your files, runs commands, and talks to your AI models. Nothing you write and no prompt you send ever leaves your local network: model traffic flows from the browser to the companion to the model server on your own hardware." },
      { p: "This guide is written in plain language for everyday use. It covers the two things people actually need: **connecting several computers** so they can work as a team, and **designing and running a collaborative build** in which several AI agents cooperate on one project. Everything here can be done from graphical screens — the only command you cannot avoid is installing the companion itself on Linux." },
      { p: "Four pieces of software make up the whole system. Knowing which piece does what makes every later chapter easier to follow." },
      { table: {
        title: "Table 1: The four moving pieces",
        headers: ["Piece", "Where it lives", "What it does"],
        widths: [22, 30, 48],
        rows: [
          ["IDE", "In your browser (any of your machines)", "The work surface: editor, file explorer, terminal, agent chat, and the Control Center used to manage computers, models and collaborative tasks."],
          ["Companion", "One per computer, always running in the background", "The local workhorse. Guards your project folders, executes file edits and commands, streams the terminal, and connects to your local model servers. Has its own built-in control page."],
          ["Model server", "Wherever a model runs (FOXAI, Ollama, LM Studio, Lemonade)", "Actually runs the AI model on that machine's hardware and answers chat requests from agents."],
          ["Workspace", "One or more folders per computer", "A project folder that a companion has **authorized**. Agents may only read and write inside authorized workspaces — nothing else on the machine is reachable."],
        ],
      } },
      { fig: { path: "/home/z/my-project/scripts/assets/guide-fig1.png", caption: "How the pieces talk on the three-machine fleet. Links between companions are authenticated with a paired device token; an agent's tools always execute on the workspace host." } },
      { note: { title: "The golden rule of collaboration", text: "Where a model runs and where the project lives are **two separate decisions**. A coding model on the Windows Dell can work on a project that lives on Ubuntu Station — the file tools simply execute on Station while the thinking happens on the Dell. You never copy a project between machines to work on it." } },
    ],
  },
  {
    h1: "2. Your Three Computers and Their Jobs",
    blocks: [
      { p: "The fleet this guide assumes consists of three machines. Their hardware differences suggest natural roles, but **nothing is fixed** — every role described here can be moved to another computer later, and the IDE will show you each machine's real capabilities as you go." },
      { table: {
        title: "Table 2: The fleet at a glance",
        headers: ["Computer", "Hardware strengths", "Natural job in the team"],
        widths: [20, 38, 42],
        rows: [
          ["Windows Dell", "Windows 11, Intel i5-12500, roughly 44 to 48 GB of RAM; FOXAI / llama.cpp already installed and working", "Home of the strongest coding model (Qwen3-Coder-30B, endpoint http://127.0.0.1:8080/v1). Runs the coder agent; can also host Windows projects — LocalForge then uses Windows path conventions automatically."],
          ["Ubuntu Station", "Ubuntu, Intel i5-7500; steady desktop, development machine", "The coordinator. Usually hosts the IDE browser session, the authoritative project copy, and the planner or reviewer agents. Optional CPU-only inference."],
          ["Ubuntu Portable", "Ubuntu, Intel i7-8850H, about 45 GB RAM, NVIDIA Quadro P2000 (4 GB VRAM)", "On-demand inference machine: models load only when a task needs them. Good home for tester or reviewer agents and for agent scratchpads and memory."],
        ],
      } },
      { p: "Two team layouts are worth knowing before you start, because both are fully supported and the choice shapes chapter 6. In **layout A** the project lives on Ubuntu Station: Station hosts the workspaces and coordinates, the Dell provides the coding model, and the Portable machine provides a tester. In **layout B** the project lives on the Dell itself: the Dell hosts the project and its coding model, Station coordinates and plans, and the Portable machine reviews. In both layouts every agent reaches the authoritative project through whichever machine hosts it — the IDE keeps model location and project location separate." },
      { p: "If you are unsure where to start, use layout A. It keeps the project on the machine where you develop daily, and it spreads the workload so no single computer is doing all three jobs at once." },
    ],
  },
  {
    h1: "3. Installing the Companion on Each Machine",
    blocks: [
      { p: "The companion is the program that makes a computer join the team. Install it on **all three machines**. It starts automatically at login, runs quietly in the background, and exposes a small local web page — the **control page** — where you can see its status without any terminal. By default it listens only to the machine itself, on port 7337, so a fresh install is safe to leave running." },
      { h2: "3.1 Windows (the Dell)" },
      { steps: [
        "Download **LocalForge-Companion-Setup-0.4.4.exe** from the IDE download screen (or from /downloads/ on the published site) and run it.",
        "Windows SmartScreen will show \"Windows protected your PC\" because the installer is self-published and not code-signed. Click **More info**, then **Run anyway**. This is expected; do not disable your antivirus.",
        "Leave **Start the LocalForge Companion tray now** checked and finish the installer.",
        "The tray app appears near the clock. It auto-starts the companion and shows the **pairing code** — a short code you will use in chapter 4. Click **Copy** when you need it.",
      ] },
      { h2: "3.2 Ubuntu (Station and Portable)" },
      { steps: [
        "Copy **localforge-companion_0.4.4_amd64.deb** onto the machine (USB stick or browser download) and install it: sudo apt install ./localforge-companion_0.4.4_amd64.deb. This single command is the only terminal step in the whole setup.",
        "The companion starts automatically as a user service at login. It also appears as a tray entry where your desktop supports one.",
        "Prefer not to install a service? Use the portable package instead: extract localforge-companion-0.4.4-linux-x64.tar.gz and run the localforge-companion file inside. The companion keeps running while that window stays open.",
        "Open **http://127.0.0.1:7337/** in a browser on that same machine. You should see the LocalForge control page with the version, the pairing code, and system status.",
      ] },
      { h2: "3.3 Check before you continue" },
      { table: {
        title: "Table 3: Installation checklist",
        headers: ["Check", "How", "Expected result"],
        widths: [30, 38, 32],
        rows: [
          ["Companion is running", "Tray icon, or open http://127.0.0.1:7337/ on that machine", "Control page shows the LocalForge name, version 0.4.4 and a build id"],
          ["Pairing code is visible", "Tray **Pairing code** box, or the control page", "A short code you can copy later for pairing"],
          ["Version and build id", "Control page header", "0.4.4 with a build id containing phase22"],
        ],
      } },
      { note: { title: "Authorized workspaces — the safety boundary", text: "A project folder becomes usable only after it is **authorized** on that machine: you open it through the IDE, or through the companion's control page. The companion then refuses every file and command request that points outside authorized workspaces. When chapter 7 asks the IDE to list a remote machine's workspaces, it shows exactly the folders that machine's companion has authorized." } },
    ],
  },
  {
    h1: "4. Connecting the Three Machines",
    blocks: [
      { p: "Fresh companions only talk to their own machine. This chapter turns three separate companions into one team over your local network. It happens in two steps per Linux machine — **enable LAN access** and **pair** — and everything is done through graphical screens." },
      { h2: "4.1 Enable LAN access graphically" },
      { p: "There are two equally good ways. Use whichever is more convenient at that moment." },
      { steps: [
        "**At the machine itself:** open http://127.0.0.1:7337/ in its browser. In the **Networking** card, set **Listen on** to \"All interfaces (LAN on)\" — or pick one specific network interface — and click **Apply**. The page reloads and shows the address that is now actually listening.",
        "**From the IDE:** open the Control Center, go to the **Computers** tab, scroll to the **Companion networking** panel, choose the computer in the selector, pick the bind address, and click **Save & Apply**. The panel shows the active listener, the machine's network interfaces and LAN addresses, and a **Connection test** box for probing another companion.",
      ] },
      { p: "The change takes effect immediately — no restart, no service editing — and **survives a restart** of the machine or the companion. If the address you picked cannot be bound (for example, the port is already taken by another program), the companion tells you clearly and **rolls back to the previous working listener and settings**, so you are never left with a broken companion." },
      { note: { title: "Why the control page is safe to leave open", text: "The control page at 127.0.0.1:7337 accepts **configuration changes only from that machine itself**. A request arriving from another computer is refused outright. Remote machines change a companion's settings only through the **authenticated** path: pair first (4.2), then use the Companion networking panel, which carries your paired device token." } },
      { h2: "4.2 Pair the machines" },
      { steps: [
        "Note each machine's LAN address — it is shown on its control page and in the Companion networking panel (for example http://192.168.1.20:7337). You do not need to fix addresses in advance; use whatever your router assigns.",
        "In the IDE (running on Station in our example), open **Control Center → Computers**. Under **Connect a computer**, paste the Dell's address, optionally a friendly name like \"Windows Dell\", and the Dell's pairing code, then click **Connect & pair**.",
        "Repeat for the Ubuntu Portable machine. After a few seconds each paired computer appears as a card with a **connected** badge, its operating system and its companion version.",
        "If you connect without entering a pairing code, the machine is registered but not trusted yet — commands will be refused until you pair with the code.",
      ] },
      { h2: "4.3 Troubleshooting the connection" },
      { table: {
        title: "Table 4: Connection symptoms and meanings",
        headers: ["Symptom", "Meaning", "Fix"],
        widths: [30, 34, 36],
        rows: [
          ["\"Could not reach\" when connecting", "The target companion still listens to its own machine only, or a firewall blocks the port", "Do 4.1 on that machine (at its keyboard); on Windows also allow the companion through the firewall prompt"],
          ["Peer card shows **unreachable** after it worked", "The machine is asleep, or its companion was stopped", "Wake the machine; start the companion from the tray (Start button)"],
          ["Pairing code rejected", "The code was regenerated (it rotates when pairing resets)", "Copy the fresh code from that machine's tray or control page"],
          ["Two companions on one machine refuse to start", "Duplicate-process protection kicked in", "This is intentional — only one companion may run per machine; close the extra one"],
        ],
      } },
    ],
  },
  {
    h1: "5. Giving Computers Their Models",
    blocks: [
      { p: "An **inference endpoint** is simply the network address of a running model server — for example, the Dell's FOXAI server answers at **http://127.0.0.1:8080/v1** with Qwen3-Coder-30B-A3B-Instruct. That endpoint is already working and tested; leave its configuration as it is. LocalForge talks to any server that speaks the OpenAI-compatible chat protocol, which covers FOXAI / llama.cpp, **Ollama** (port 11434), **LM Studio** (port 1234) and **Lemonade** (port 8000)." },
      { p: "Each companion automatically **discovers** model servers running on its own machine — they appear in the IDE with no configuration. The Dell's Qwen3-Coder will simply be there once the machines are paired. If a server is not listed, start it on that machine and refresh; the companion probes the well-known ports plus any extra address you add." },
      { h2: "5.1 The Model Manager" },
      { p: "The **Models** tab of the Control Center manages local models on any paired computer — select a machine at the top and you see its folders, profiles, and which servers are loaded right now. You can load or unload a model on a remote machine from here; the request travels through the IDE to that machine's companion." },
      { p: "Each model profile has a **residency** setting. **On-demand** means the model loads when a task needs it and is freed afterwards — ideal for the Portable machine, where you do not want the Quadro GPU occupied all day. **Keep loaded** means the model stays resident so every request is instant — ideal for the Dell's workhorse coder, which you will use constantly during a build." },
      { table: {
        title: "Table 5: A sensible model layout for this fleet",
        headers: ["Machine", "Endpoint", "Model", "Residency"],
        widths: [20, 30, 30, 20],
        rows: [
          ["Windows Dell", "http://127.0.0.1:8080/v1 (FOXAI)", "Qwen3-Coder-30B-A3B-Instruct", "keep loaded"],
          ["Ubuntu Station", "its own detected server, or none", "a small planner/reviewer model, CPU or none", "on-demand"],
          ["Ubuntu Portable", "detected Ollama / Lemonade", "a small tester model sized for 4 GB VRAM", "on-demand"],
        ],
      } },
      { note: { title: "One address, two meanings", text: "An endpoint is always written **as the machine running the model sees it**. The Dell's FOXAI stays http://127.0.0.1:8080/v1 even though Station coordinates the build — from the Dell's point of view that address is localhost. When you fill in a participant's endpoint in chapter 7, enter the address that works **on that participant's machine**." } },
      { h2: "5.2 Inference timeouts: slow hardware is not an outage" },
      { p: "A model server on slow hardware can legitimately spend **many minutes** before it produces the first token — large prompts must be processed first, and a server running with a single inference slot may also be finishing the previous request. LocalForge 0.4.4 therefore gives every provider its own **inference timeout** (Settings → Providers): how long one chat request may take before the IDE gives up on it. The default is **20 minutes**, it can be raised to **120 minutes** per provider, and it is never lowered automatically." },
      { p: "If the timeout does fire, the IDE reports it precisely: **\"Inference timeout — the model server did not finish within N min. This is NOT an outage.\"** The request reached the server and may still be running, so LocalForge deliberately **does not resend it** — resending would queue a duplicate behind the busy server (a real problem when the server allows one inference at a time). The run pauses with all progress preserved; you can continue once the server frees up, or raise the timeout for that provider. A genuine connection failure — server actually down or unreachable — is reported separately (\"Cannot connect to the model server\") and retried a bounded number of times." },
      { note: { title: "Rule of thumb", text: "Prompt processing of a 32K-context prompt can take 2–10+ minutes on CPU-bound machines. If you see inference timeouts during long agent turns, raise that provider's timeout rather than shrinking the model's context — LocalForge never reduces your context window or output budget to work around a timeout." } },
    ],
  },
];
