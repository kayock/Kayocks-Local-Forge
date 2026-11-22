"""Figure 1 for the LocalForge Users Guide: how the pieces talk across three machines."""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import matplotlib.font_manager as fm
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

fm.fontManager.addfont('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf')
plt.rcParams['font.sans-serif'] = ['DejaVu Sans']
plt.rcParams['axes.unicode_minus'] = False

PRIMARY = "#162235"
ACCENT = "#1B6B7A"
LIGHT = "#EDF3F5"
MID = "#5B8DB8"
GREY = "#5B6B7D"
RED = "#B87472"

fig, ax = plt.subplots(figsize=(11, 5.4), constrained_layout=True)
ax.set_xlim(0, 100); ax.set_ylim(0, 54); ax.axis("off")

def machine(x, y, w, h, name, sub, fill):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.6,rounding_size=1.4",
                                facecolor=fill, edgecolor=ACCENT, linewidth=1.6))
    ax.text(x + w/2, y + h - 3.2, name, ha="center", va="center", fontsize=12.5,
            fontweight="bold", color=PRIMARY)
    ax.text(x + w/2, y + h - 6.4, sub, ha="center", va="center", fontsize=8.5, color=GREY)

def box(x, y, w, h, label, fill, ec, fs=9.0, tc=PRIMARY, bold=False):
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle="round,pad=0.35,rounding_size=0.9",
                                facecolor=fill, edgecolor=ec, linewidth=1.2))
    ax.text(x + w/2, y + h/2, label, ha="center", va="center", fontsize=fs,
            color=tc, fontweight="bold" if bold else "normal")

def arrow(x1, y1, x2, y2, color, style="-", lw=1.7):
    ax.add_patch(FancyArrowPatch((x1, y1), (x2, y2), arrowstyle="-|>", mutation_scale=13,
                                 color=color, linewidth=lw, linestyle=style))

# ── Three machines (y 27..57) ──
machine(2, 21, 30, 30, "Windows Dell", "i5-12500 · ~46 GB RAM", "#FFFFFF")
machine(35, 21, 30, 30, "Ubuntu Station", "i5-7500 · coordination + development", LIGHT)
machine(68, 21, 30, 30, "Ubuntu Portable", "i7-8850H · Quadro P2000 · on-demand", "#FFFFFF")

# Dell internals
box(4.5, 36, 25, 6.0, "Companion  :7337", "#FFFFFF", ACCENT, bold=True)
box(4.5, 27.5, 11.5, 6.0, "FOXAI /\nllama.cpp", "#FFFFFF", MID, fs=8.0)
box(18.0, 27.5, 11.5, 6.0, "Qwen3-Coder-30B\n:8080/v1", "#FFFFFF", MID, fs=8.0)
box(4.5, 22.6, 25, 3.6, "Workspace  D:\\dev\\my-app  (authorized)", LIGHT, "#C8DDE2", fs=7.8)

# Station internals
box(37.5, 36, 25, 6.0, "Companion  :7337", "#FFFFFF", ACCENT, bold=True)
box(37.5, 27.5, 11.5, 6.0, "Browser\n(IDE runs here)", LIGHT, ACCENT, fs=8.0, bold=True)
box(51.0, 27.5, 11.5, 6.0, "Project\nfolders", "#FFFFFF", MID, fs=8.0)
box(37.5, 22.6, 25, 3.6, "Workspaces  ~/projects  (authorized)", LIGHT, "#C8DDE2", fs=7.8)

# Portable internals
box(70.5, 36, 25, 6.0, "Companion  :7337", "#FFFFFF", ACCENT, bold=True)
box(70.5, 27.5, 11.5, 6.0, "Ollama /\nLemonade", "#FFFFFF", MID, fs=8.0)
box(84.0, 27.5, 11.5, 6.0, "Models load\nwhen needed", "#FFFFFF", MID, fs=8.0)
box(70.5, 22.6, 25, 3.6, "Agent scratchpads + memory", LIGHT, "#C8DDE2", fs=7.8)

# ── Flows ──
ax.text(50, 52.8, "Your LAN — Control Center → Computers links the three companions",
        ha="center", fontsize=9.4, color=PRIMARY, fontweight="bold")

# inter-companion links at companion-box mid height (y=45)
arrow(29.7, 39, 37.3, 39, RED, lw=1.9)
arrow(62.7, 39, 70.3, 39, RED, lw=1.9)


# browser → local companion ("you work here")
arrow(44.6, 33.6, 46.6, 35.8, ACCENT, lw=1.5)
ax.text(37.0, 34.6, "you work here", ha="left", va="center", fontsize=8.0,
        color=ACCENT, fontweight="bold")

# companion → its own model server (Dell example)
arrow(10.2, 35.8, 10.2, 33.7, MID, lw=1.5)
ax.text(12.6, 34.9, "asks its own model server", ha="left", va="center",
        fontsize=7.8, color=MID)

# ── Bottom callouts ──
ax.text(50, 15.8, "Model traffic never leaves your machines:  browser → companion → local model server",
        ha="center", fontsize=9.4, color=PRIMARY,
        bbox=dict(boxstyle="round,pad=0.45", fc=LIGHT, ec=ACCENT, lw=1.2))
ax.text(50, 10.8, "Golden rule: where a model runs and where the project lives are two separate choices.",
        ha="center", fontsize=9.0, color=GREY, style="italic")

fig.savefig("/home/z/my-project/scripts/assets/guide-fig1.png", dpi=200, facecolor="white")
from PIL import Image
im = Image.open("/home/z/my-project/scripts/assets/guide-fig1.png").convert("RGB")
im.thumbnail((1100, 620)); im.save("/tmp/fig1-check.jpg", quality=70)
h = im.convert("L").histogram()
print(im.size, "non-white", round(1 - h[255] / sum(h), 3))
