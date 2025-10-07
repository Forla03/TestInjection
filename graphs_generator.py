#!/usr/bin/env python3
"""
Boxplots per walking_type + boxplot generale, con verity (ground truth) = 50 steps.

Come usare:
  - Imposta CSV_PATH al tuo file .csv
  - Imposta OUT_DIR dove salvare i grafici
  - (Opzionale) TRUTH e SHOW
  - Esegui
"""
from pathlib import Path
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.ticker import MaxNLocator

# ====== COSTANTI DA MODIFICARE ======
#CSV_PATH = Path("results_run.csv")  # <--- cambia qui
#OUT_DIR  = Path("runtastic_graphs")  # <--- cambia qui
#CSV_PATH = Path("results_tayutau.csv") 
#OUT_DIR  = Path("tayutau_graphs")  
#CSV_PATH = Path("results_walklogger.csv") 
#OUT_DIR  = Path("walklogger_graphs")  
CSV_PATH = Path("results_accupedo.csv") 
OUT_DIR  = Path("accupedo_graphs")  

TRUTH    = 50.0  # verity (ground truth) 
SHOW     = False  # True per visualizzare i grafici a schermo
# ====================================

STEP_CANDIDATES = ["steps_counted", "step_count", "steps", "counted_steps", "algo_steps"]

def find_step_col(df: pd.DataFrame) -> str:
    for c in STEP_CANDIDATES:
        if c in df.columns and pd.api.types.is_numeric_dtype(df[c]):
            return c
    for c in df.columns:
        if "step" in c.lower() and pd.api.types.is_numeric_dtype(df[c]):
            return c
    raise ValueError("Impossibile trovare la colonna dei passi. Attese: " + ", ".join(STEP_CANDIDATES))

def ensure_outdir(p: Path) -> Path:
    p.mkdir(parents=True, exist_ok=True)
    return p

def jittered(x, n, scale=0.08, rng=None):
    """Genera valori jittered per visualizzare meglio i punti sovrapposti."""
    if rng is None:
        rng = np.random.default_rng(42)
    return x + rng.uniform(-scale, scale, size=n)

def boxplot_series(values, title, ylabel, save_path: Path, show_truth_line=False, truth_value=None):
    """Boxplot singolo con punti e opzionale linea di ground truth."""
    fig, ax = plt.subplots(figsize=(6, 5))
    bp = ax.boxplot(values, showmeans=True)
    # Aggiungi i punti dei dati
    y_data = values[0] if isinstance(values[0], np.ndarray) else values
    x = np.full_like(y_data, 1, dtype=float)
    xj = jittered(x, len(y_data), scale=0.08)
    ax.scatter(xj, y_data, alpha=0.6, s=18, zorder=3)
    # Linea di ground truth se richiesta
    if show_truth_line:
        if truth_value is None:
            truth_value = TRUTH
        label = f"Ground truth ({int(truth_value)})" if truth_value != 0 else "Errore ideale (0)"
        ax.axhline(truth_value, linestyle="-", linewidth=1.5, color="red", label=label)
        ax.legend()
    ax.set_title(title)
    ax.set_ylabel(ylabel)
    ax.grid(True, axis="y", linestyle="--", alpha=0.35)
    plt.tight_layout()
    plt.savefig(save_path, dpi=220)
    plt.close(fig)

def boxplot_by_category(df, cat_col, value_col, title, xlabel, ylabel, save_path: Path):
    """Boxplot per categoria con punti, linea di ground truth e griglia."""
    # ordina categorie per mediana del valore per migliorare leggibilità
    order = (df[[cat_col, value_col]]
             .dropna()
             .groupby(cat_col)[value_col]
             .median()
             .sort_values()
             .index.tolist())
    data = [df[df[cat_col] == k][value_col].dropna().values for k in order]
    labels = list(order)
    
    fig, ax = plt.subplots(figsize=(10, 5))
    bp = ax.boxplot(data, labels=labels, showmeans=True)
    
    # Aggiungi i punti dei dati per ogni categoria
    for i, vals in enumerate(data, start=1):
        x = np.full_like(vals, i, dtype=float)
        xj = jittered(x, len(vals), scale=0.08)
        ax.scatter(xj, vals, alpha=0.6, s=18, zorder=3)
    
    # Linea di ground truth
    if "error" in value_col.lower() or "step" in value_col.lower():
        if "error" not in value_col.lower():  # Solo per grafici di passi
            ax.axhline(TRUTH, linestyle="-", linewidth=1.5, color="red", label=f"Ground truth ({int(TRUTH)})")
            ax.legend()
        else:  # Per grafici di errore, linea a 0
            ax.axhline(0, linestyle="-", linewidth=1.5, color="red", label="Errore = 0")
            ax.legend()
    
    ax.set_title(title)
    ax.set_xlabel(xlabel)
    ax.set_ylabel(ylabel)
    ax.grid(True, axis="y", linestyle="--", alpha=0.35)
    plt.xticks(rotation=15)
    plt.tight_layout()
    plt.savefig(save_path, dpi=220)
    plt.close(fig)

def bar_overall_mae(df: pd.DataFrame, mae_col: str, title: str, ylabel: str, save_path: Path):
    """Grafico a barre per MAE totale."""
    val = float(df[mae_col].mean())
    fig, ax = plt.subplots(figsize=(4, 5))
    ax.bar(["MAE totale"], [val], color='steelblue')
    ax.set_ylim(bottom=0)
    ax.set_title(title)
    ax.set_ylabel(ylabel)
    ax.yaxis.set_major_locator(MaxNLocator(integer=True))
    ax.text(0, val, f"{val:.2f}", ha="center", va="bottom", fontsize=12, fontweight='bold')
    ax.grid(True, axis="y", linestyle="--", alpha=0.35)
    plt.tight_layout()
    plt.savefig(save_path, dpi=220)
    plt.close(fig)

def main():
    csv_path = CSV_PATH
    out_dir = ensure_outdir(OUT_DIR)

    df = pd.read_csv(csv_path)

    step_col = find_step_col(df)
    if "walking_type" not in df.columns:
        raise ValueError("Colonna 'walking_type' non trovata nel CSV.")
    
    # Verifica se esiste la colonna phone_position
    has_phone_position = "phone_position" in df.columns

    # colonne di interesse
    df["error"] = df[step_col] - TRUTH
    df["abs_error"] = df["error"].abs()

    # Boxplot generale passi
    gen_steps_path = out_dir / "boxplot_steps_overall.png"
    boxplot_series([df[step_col].dropna().values], 
                   title=f"Distribuzione {step_col} (overall)",
                   ylabel=step_col, 
                   save_path=gen_steps_path,
                   show_truth_line=True,
                   truth_value=TRUTH)

    # Boxplot generale errore
    gen_err_path = out_dir / "boxplot_error_overall.png"
    boxplot_series([df["error"].dropna().values],
                   title=f"Errore (counted - {int(TRUTH)}) overall",
                   ylabel="errore",
                   save_path=gen_err_path,
                   show_truth_line=True,
                   truth_value=0)

    # Boxplot per walking_type: passi contati
    by_type_steps_path = out_dir / "boxplot_steps_by_walking_type.png"
    boxplot_by_category(df, "walking_type", step_col,
                        title=f"{step_col} per walking_type",
                        xlabel="walking_type",
                        ylabel=step_col,
                        save_path=by_type_steps_path)

    # Boxplot per walking_type: errore
    by_type_err_path = out_dir / "boxplot_error_by_walking_type.png"
    boxplot_by_category(df, "walking_type", "error",
                        title=f"Errore (counted - {int(TRUTH)}) per walking_type",
                        xlabel="walking_type",
                        ylabel="errore",
                        save_path=by_type_err_path)

    # Boxplot per walking_type: errore assoluto
    by_type_abserr_path = out_dir / "boxplot_abs_error_by_walking_type.png"
    boxplot_by_category(df, "walking_type", "abs_error",
                        title=f"|Errore| per walking_type (truth={int(TRUTH)})",
                        xlabel="walking_type",
                        ylabel="|errore|",
                        save_path=by_type_abserr_path)

    # Grafico MAE totale
    mae_bar_path = out_dir / "overall_mae_bar.png"
    bar_overall_mae(df, "abs_error", "Errore Assoluto Medio (MAE) - Totale", "MAE", mae_bar_path)

    saved_paths = [gen_steps_path, gen_err_path, by_type_steps_path, by_type_err_path, by_type_abserr_path, mae_bar_path]

    # Grafici per phone_position se la colonna esiste
    if has_phone_position:
        # Boxplot per phone_position: passi contati
        by_pos_steps_path = out_dir / "boxplot_steps_by_phone_position.png"
        boxplot_by_category(df, "phone_position", step_col,
                            title=f"{step_col} per phone_position",
                            xlabel="phone_position",
                            ylabel=step_col,
                            save_path=by_pos_steps_path)
        saved_paths.append(by_pos_steps_path)

        # Boxplot per phone_position: errore
        by_pos_err_path = out_dir / "boxplot_error_by_phone_position.png"
        boxplot_by_category(df, "phone_position", "error",
                            title=f"Errore (counted - {int(TRUTH)}) per phone_position",
                            xlabel="phone_position",
                            ylabel="errore",
                            save_path=by_pos_err_path)
        saved_paths.append(by_pos_err_path)

        # Boxplot per phone_position: errore assoluto
        by_pos_abserr_path = out_dir / "boxplot_abs_error_by_phone_position.png"
        boxplot_by_category(df, "phone_position", "abs_error",
                            title=f"|Errore| per phone_position (truth={int(TRUTH)})",
                            xlabel="phone_position",
                            ylabel="|errore|",
                            save_path=by_pos_abserr_path)
        saved_paths.append(by_pos_abserr_path)

    print("Saved:")
    for p in saved_paths:
        print(" -", p)

    if SHOW:
        import matplotlib.image as mpimg
        for p in saved_paths:
            img = mpimg.imread(p)
            plt.figure()
            plt.imshow(img)
            plt.axis("off")
            plt.title(p.name)
            plt.show()

if __name__ == "__main__":
    main()
