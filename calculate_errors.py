import csv
import statistics

# Leggi il CSV
errors = []
with open('verification.csv', 'r') as f:
    reader = csv.DictReader(f)
    for row in reader:
        errors.append(int(row['absolute_error']))

# Calcola quartili e IQR
errors_sorted = sorted(errors)
n = len(errors_sorted)
Q1 = errors_sorted[n // 4]
Q3 = errors_sorted[3 * n // 4]
IQR = Q3 - Q1

# Identifica outliers con metodo IQR
lower_bound = Q1 - 1.5 * IQR
upper_bound = Q3 + 1.5 * IQR

outliers = [e for e in errors if e < lower_bound or e > upper_bound]
non_outliers = [e for e in errors if lower_bound <= e <= upper_bound]

# Calcola medie
mean_all = statistics.mean(errors)
mean_no_outliers = statistics.mean(non_outliers)

print("=" * 60)
print("ANALISI ERRORE ASSOLUTO - verification.csv")
print("=" * 60)
print(f"\nDati totali: {len(errors)}")
print(f"\nStatistiche distribuzione:")
print(f"  Q1 (25° percentile): {Q1}")
print(f"  Mediana (50° percentile): {statistics.median(errors)}")
print(f"  Q3 (75° percentile): {Q3}")
print(f"  IQR (Interquartile Range): {IQR}")
print(f"\nSoglie outlier (metodo IQR):")
print(f"  Lower bound: {lower_bound}")
print(f"  Upper bound: {upper_bound}")
print(f"\nOutliers trovati: {len(outliers)}")
if outliers:
    print(f"  Valori: {sorted(outliers)}")
    # Trova i file con outliers
    print(f"\n  File con outliers:")
    with open('verification.csv', 'r') as f:
        reader = csv.DictReader(f)
        for row in reader:
            if int(row['absolute_error']) in outliers:
                # Estrai solo le informazioni rilevanti dal nome del file
                parts = row['file_name'].split('_')
                walking_type = '_'.join([p for p in parts if p in ['PLAIN', 'WALKING', 'RUNNING', 'IRREGULAR', 'STEPS', 'BABY', 'UPHILL', 'DOWNHILL']])
                position = next((p for p in parts if p in ['HAND', 'SHOULDER', 'POCKET']), 'unknown')
                print(f"    - {walking_type}_{position}: error={row['absolute_error']} (live={row['steps_live']}, batch={row['steps_batch']})")

print(f"\nDati non-outliers: {len(non_outliers)}")
print("\n" + "=" * 60)
print("RISULTATI")
print("=" * 60)
print(f"\n✓ Errore Assoluto Medio (con outliers):    {mean_all:.2f}")
print(f"✓ Errore Assoluto Medio (senza outliers):  {mean_no_outliers:.2f}")
print(f"\nRiduzione errore: {mean_all - mean_no_outliers:.2f} ({((mean_all - mean_no_outliers) / mean_all * 100):.1f}%)")
print("=" * 60)
