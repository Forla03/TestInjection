#!/usr/bin/env python3
"""
Boxplots per walking_type + boxplot generale, con verity (ground truth) = 50 steps.

Come usare:
  - Imposta CSV_PATH al tuo file .csv (o None per processare tutte le configurazioni Forlani)
  - Imposta OUT_DIR dove salvare i grafici (o None per auto-generare)
  - (Opzionale) TRUTH e SHOW
  - Esegui
"""
from pathlib import Path
import pandas as pd
import numpy as np
import matplotlib.pyplot as plt
from matplotlib.ticker import MaxNLocator
import sys

# ====== COSTANTI DA MODIFICARE ======
# Opzione 1: Singolo file
#CSV_PATH = Path("results_run.csv")  # <--- cambia qui
#OUT_DIR  = Path("runtastic_graphs")  # <--- cambia qui
#CSV_PATH = Path("results_tayutau.csv") 
#OUT_DIR  = Path("tayutau_graphs")  
#CSV_PATH = Path("results_walklogger.csv") 
#OUT_DIR  = Path("walklogger_graphs")  
#CSV_PATH = Path("results_accupedo.csv") 
#OUT_DIR  = Path("accupedo_graphs")  

# Opzione 2: Processa tutti i file Forlani automaticamente
CSV_PATH = None  # None = auto-detect tutti i file Forlani
OUT_DIR  = None  # None = auto-genera cartelle per ogni configurazione

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

def get_config_name_from_filename(filename: str) -> str:
    """Estrae un nome leggibile dalla configurazione dal nome del file."""
    filename = filename.lower()
    if "peak_butterworth" in filename:
        return "Peak + Butterworth Filter"
    elif "peak_intersection_low_pass_10hz" in filename:
        return "Peak + Intersection + Low-Pass 10Hz"
    elif "peak_intersection_low_pass_2percent" in filename:
        return "Peak + Intersection + Low-Pass 2%"
    elif "peak_time_filtering_low_pass_10hz" in filename:
        return "Peak + Time Filtering + Low-Pass 10Hz"
    elif "peak_low_pass" in filename:
        return "Peak + Low-Pass Filter"
    return "Unknown Config"

def find_all_forlani_configs() -> list:
    """Trova tutti i file results_forlani_*.csv nella directory corrente."""
    current_dir = Path(".")
    forlani_files = []
    
    # Pattern dei file Forlani conosciuti
    patterns = [
        "results_forlani_peak_butterworth.csv",
        "results_forlani_peak_intersection_low_pass_10hz.csv",
        "results_forlani_peak_low_pass.csv",
        "results_forlani_peak_intersection_low_pass_2percent.csv",
        "results_forlani_peak_time_filtering_low_pass_10hz.csv"
    ]
    
    for pattern in patterns:
        file_path = current_dir / pattern
        if file_path.exists():
            # Determina il nome della cartella di output
            if "peak_butterworth" in pattern:
                out_dir = "forlani_graphs_peak_butterworth"
            elif "peak_intersection_low_pass_10hz" in pattern:
                out_dir = "forlani_graphs_peak_intersection_low_pass_10hz"
            elif "peak_intersection_low_pass_2percent" in pattern:
                out_dir = "forlani_graphs_peak_intersection_low_pass_2percent"
            elif "peak_time_filtering_low_pass_10hz" in pattern:
                out_dir = "forlani_graphs_peak_time_filtering_low_pass_10hz"
            elif "peak_low_pass" in pattern:
                out_dir = "forlani_graphs_peak_low_pass"
            else:
                out_dir = "forlani_graphs_unknown"
            
            forlani_files.append({
                'csv_path': file_path,
                'out_dir': Path(out_dir),
                'config_name': get_config_name_from_filename(pattern)
            })
    
    return forlani_files

def process_single_csv(csv_path: Path, out_dir: Path, config_name: str = None):
    """Processa un singolo file CSV e genera i grafici."""
    out_dir = ensure_outdir(out_dir)

    print(f"\n{'='*60}")
    if config_name:
        print(f"Processing: {config_name}")
    print(f"CSV: {csv_path}")
    print(f"Output: {out_dir}")
    print('='*60)

    df = pd.read_csv(csv_path)

    step_col = find_step_col(df)
    if "walking_type" not in df.columns:
        raise ValueError("Colonna 'walking_type' non trovata nel CSV.")
    
    # Verifica se esiste la colonna phone_position
    has_phone_position = "phone_position" in df.columns

    # colonne di interesse
    df["error"] = df[step_col] - TRUTH
    df["abs_error"] = df["error"].abs()

    # Aggiungi il nome della configurazione ai titoli se disponibile
    title_suffix = f" ({config_name})" if config_name else ""

    # Boxplot generale passi
    gen_steps_path = out_dir / "boxplot_steps_overall.png"
    boxplot_series([df[step_col].dropna().values], 
                   title=f"Distribuzione {step_col} (overall){title_suffix}",
                   ylabel=step_col, 
                   save_path=gen_steps_path,
                   show_truth_line=True,
                   truth_value=TRUTH)

    # Boxplot generale errore
    gen_err_path = out_dir / "boxplot_error_overall.png"
    boxplot_series([df["error"].dropna().values],
                   title=f"Errore (counted - {int(TRUTH)}) overall{title_suffix}",
                   ylabel="errore",
                   save_path=gen_err_path,
                   show_truth_line=True,
                   truth_value=0)

    # Boxplot per walking_type: passi contati
    by_type_steps_path = out_dir / "boxplot_steps_by_walking_type.png"
    boxplot_by_category(df, "walking_type", step_col,
                        title=f"{step_col} per walking_type{title_suffix}",
                        xlabel="walking_type",
                        ylabel=step_col,
                        save_path=by_type_steps_path)

    # Boxplot per walking_type: errore
    by_type_err_path = out_dir / "boxplot_error_by_walking_type.png"
    boxplot_by_category(df, "walking_type", "error",
                        title=f"Errore (counted - {int(TRUTH)}) per walking_type{title_suffix}",
                        xlabel="walking_type",
                        ylabel="errore",
                        save_path=by_type_err_path)

    # Boxplot per walking_type: errore assoluto
    by_type_abserr_path = out_dir / "boxplot_abs_error_by_walking_type.png"
    boxplot_by_category(df, "walking_type", "abs_error",
                        title=f"|Errore| per walking_type (truth={int(TRUTH)}){title_suffix}",
                        xlabel="walking_type",
                        ylabel="|errore|",
                        save_path=by_type_abserr_path)

    # Grafico MAE totale
    mae_bar_path = out_dir / "overall_mae_bar.png"
    bar_overall_mae(df, "abs_error", f"Errore Assoluto Medio (MAE) - Totale{title_suffix}", "MAE", mae_bar_path)

    saved_paths = [gen_steps_path, gen_err_path, by_type_steps_path, by_type_err_path, by_type_abserr_path, mae_bar_path]

    # Grafici per phone_position se la colonna esiste
    if has_phone_position:
        # Boxplot per phone_position: passi contati
        by_pos_steps_path = out_dir / "boxplot_steps_by_phone_position.png"
        boxplot_by_category(df, "phone_position", step_col,
                            title=f"{step_col} per phone_position{title_suffix}",
                            xlabel="phone_position",
                            ylabel=step_col,
                            save_path=by_pos_steps_path)
        saved_paths.append(by_pos_steps_path)

        # Boxplot per phone_position: errore
        by_pos_err_path = out_dir / "boxplot_error_by_phone_position.png"
        boxplot_by_category(df, "phone_position", "error",
                            title=f"Errore (counted - {int(TRUTH)}) per phone_position{title_suffix}",
                            xlabel="phone_position",
                            ylabel="errore",
                            save_path=by_pos_err_path)
        saved_paths.append(by_pos_err_path)

        # Boxplot per phone_position: errore assoluto
        by_pos_abserr_path = out_dir / "boxplot_abs_error_by_phone_position.png"
        boxplot_by_category(df, "phone_position", "abs_error",
                            title=f"|Errore| per phone_position (truth={int(TRUTH)}){title_suffix}",
                            xlabel="phone_position",
                            ylabel="|errore|",
                            save_path=by_pos_abserr_path)
        saved_paths.append(by_pos_abserr_path)

    print("\nSaved:")
    for p in saved_paths:
        print(f" - {p}")

    if SHOW:
        import matplotlib.image as mpimg
        for p in saved_paths:
            img = mpimg.imread(p)
            plt.figure()
            plt.imshow(img)
            plt.axis("off")
            plt.title(p.name)
            plt.show()

def main():
    # Modalità auto-detect per Forlani
    if CSV_PATH is None and OUT_DIR is None:
        forlani_configs = find_all_forlani_configs()
        
        if not forlani_configs:
            print("Nessun file results_forlani_*.csv trovato nella directory corrente.")
            print("Imposta CSV_PATH e OUT_DIR per processare altri file.")
            sys.exit(1)
        
        print(f"Trovate {len(forlani_configs)} configurazioni Forlani da processare:")
        for config in forlani_configs:
            print(f"  - {config['config_name']}: {config['csv_path'].name}")
        
        # Processa tutte le configurazioni
        for config in forlani_configs:
            try:
                process_single_csv(
                    csv_path=config['csv_path'],
                    out_dir=config['out_dir'],
                    config_name=config['config_name']
                )
            except Exception as e:
                print(f"\nERRORE durante il processing di {config['csv_path']}: {e}")
                continue
        
        print(f"\n{'='*60}")
        print(f"Completato! Processate {len(forlani_configs)} configurazioni.")
        print('='*60)
    
    # Modalità singolo file (compatibilità retroattiva)
    else:
        if CSV_PATH is None or OUT_DIR is None:
            print("Errore: Imposta sia CSV_PATH che OUT_DIR, oppure lascia entrambi a None per auto-detect.")
            sys.exit(1)
        
        process_single_csv(csv_path=CSV_PATH, out_dir=OUT_DIR)

if __name__ == "__main__":
    main()
