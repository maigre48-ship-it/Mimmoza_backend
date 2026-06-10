<#
.SYNOPSIS
    Import FiLoSoFi (INSEE revenus/pauvreté) dans Supabase.

.DESCRIPTION
    Pipeline complet :
    1. Crée staging + indexes via SQL migration
    2. Détecte le séparateur et les colonnes du CSV
    3. Importe le CSV dans filosofi_staging via psql \copy
    4. Transforme et UPSERT vers insee_socioeco_communes
    5. Affiche les résultats de validation

.PARAMETER CsvPath
    Chemin vers le fichier CSV FiLoSoFi local.

.PARAMETER DatabaseUrl
    URL de connexion PostgreSQL (format: postgresql://user:pwd@host:port/db).
    Si absent, utilise la variable d'environnement DATABASE_URL.

.PARAMETER PsqlPath
    Chemin vers psql.exe (défaut: psql dans le PATH).

.PARAMETER SkipMigration
    Si présent, saute l'étape de création staging/indexes (utile pour re-run).

.EXAMPLE
    .\import-filosofi.ps1 -CsvPath "C:\data\filosofi_communes.csv"
    .\import-filosofi.ps1 -CsvPath ".\data\FILO2021.csv" -DatabaseUrl "postgresql://postgres.xxx:pwd@aws-0-eu-west.pooler.supabase.com:6543/postgres"
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path $_ -PathType Leaf })]
    [string]$CsvPath,

    [Parameter(Mandatory = $false)]
    [string]$DatabaseUrl = $env:DATABASE_URL,

    [Parameter(Mandatory = $false)]
    [string]$PsqlPath = "psql",

    [Parameter(Mandatory = $false)]
    [string]$MigrationPath = "",

    [switch]$SkipMigration
)

# ============================================================================
# Configuration
# ============================================================================
$ErrorActionPreference = "Stop"
$StartTime = Get-Date
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# Résoudre le chemin migration
if (-not $MigrationPath) {
    $MigrationPath = Join-Path $ScriptDir "..\supabase\migrations\20250216_filosofi_import.sql"
    if (-not (Test-Path $MigrationPath)) {
        # Fallback : même dossier que le script
        $MigrationPath = Join-Path $ScriptDir "20250216_filosofi_import.sql"
    }
}

# ============================================================================
# Fonctions utilitaires
# ============================================================================
function Write-Step {
    param([string]$Msg)
    $ts = (Get-Date).ToString("HH:mm:ss")
    Write-Host ""
    Write-Host "[$ts] >>> $Msg" -ForegroundColor Cyan
}

function Write-Ok {
    param([string]$Msg)
    Write-Host "    OK: $Msg" -ForegroundColor Green
}

function Write-Warn {
    param([string]$Msg)
    Write-Host "    WARN: $Msg" -ForegroundColor Yellow
}

function Write-Err {
    param([string]$Msg)
    Write-Host "    ERREUR: $Msg" -ForegroundColor Red
}

function Invoke-Psql {
    param(
        [string]$Sql,
        [switch]$ReturnOutput
    )
    $tmpFile = [System.IO.Path]::GetTempFileName() + ".sql"
    $Sql | Out-File -FilePath $tmpFile -Encoding UTF8

    try {
        if ($ReturnOutput) {
            $result = & $PsqlPath $DatabaseUrl -f $tmpFile -t -A -X 2>&1
            if ($LASTEXITCODE -ne 0) {
                Write-Err "psql a retourné le code $LASTEXITCODE"
                Write-Err ($result -join "`n")
                throw "Erreur psql (code $LASTEXITCODE)"
            }
            return ($result | Out-String).Trim()
        }
        else {
            & $PsqlPath $DatabaseUrl -f $tmpFile -X -v ON_ERROR_STOP=1 2>&1 | ForEach-Object {
                if ($_ -match "^ERROR|^FATAL") {
                    Write-Err $_
                }
                else {
                    Write-Host "    $_" -ForegroundColor DarkGray
                }
            }
            if ($LASTEXITCODE -ne 0) {
                throw "Erreur psql (code $LASTEXITCODE)"
            }
        }
    }
    finally {
        Remove-Item $tmpFile -ErrorAction SilentlyContinue
    }
}

# ============================================================================
# Validation des prérequis
# ============================================================================
Write-Host "============================================================" -ForegroundColor White
Write-Host "  IMPORT FILOSOFI → insee_socioeco_communes" -ForegroundColor White
Write-Host "============================================================" -ForegroundColor White

Write-Step "Vérification des prérequis"

# Vérif DatabaseUrl
if (-not $DatabaseUrl) {
    Write-Err "DATABASE_URL non défini. Utilisez -DatabaseUrl ou définissez `$env:DATABASE_URL"
    exit 1
}
Write-Ok "DATABASE_URL configuré"

# Vérif psql
try {
    $null = & $PsqlPath --version 2>&1
    Write-Ok "psql trouvé: $(& $PsqlPath --version 2>&1 | Select-Object -First 1)"
}
catch {
    Write-Err "psql introuvable. Installez PostgreSQL ou spécifiez -PsqlPath"
    exit 1
}

# Vérif CSV
$csvFullPath = Resolve-Path $CsvPath
$csvSize = (Get-Item $csvFullPath).Length / 1MB
Write-Ok "CSV: $csvFullPath ($([math]::Round($csvSize, 1)) Mo)"

# ============================================================================
# Étape 1 : Analyser le CSV (séparateur, colonnes)
# ============================================================================
Write-Step "Analyse du CSV"

# Lire les premières lignes
$rawLines = Get-Content $csvFullPath -TotalCount 5 -Encoding UTF8
$headerLine = $rawLines[0]

# Détecter le séparateur
$sepCandidates = @{
    ";"  = ($headerLine.ToCharArray() | Where-Object { $_ -eq ';' }).Count
    ","  = ($headerLine.ToCharArray() | Where-Object { $_ -eq ',' }).Count
    "`t" = ($headerLine.ToCharArray() | Where-Object { $_ -eq "`t" }).Count
}
$csvSep = ($sepCandidates.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1).Key
Write-Ok "Séparateur détecté: '$csvSep'"

# Parser les colonnes
$columns = $headerLine.Split($csvSep) | ForEach-Object { $_.Trim().Trim('"').ToLower() }
Write-Ok "Colonnes trouvées: $($columns.Count)"
Write-Host "    Premières colonnes: $($columns[0..([Math]::Min(9, $columns.Count - 1))] -join ', ')" -ForegroundColor DarkGray

# Détecter le format
$isWide = $columns -contains "med21" -or $columns -contains "med20" -or $columns -contains "med19"
$isLong = $columns -contains "annee" -and ($columns -contains "med" -or $columns -contains "mediane")

if ($isWide) {
    Write-Ok "Format détecté: WIDE (colonnes MED21, MED20, etc.)"
}
elseif ($isLong) {
    Write-Ok "Format détecté: LONG (colonne annee + med)"
}
else {
    Write-Warn "Format incertain — les fonctions SQL tenteront la détection auto"
    Write-Host "    Colonnes: $($columns -join ', ')" -ForegroundColor Yellow
}

# ============================================================================
# Étape 2 : Préparer le CSV pour \copy
# On crée un CSV intermédiaire mappé vers les colonnes staging
# ============================================================================
Write-Step "Préparation du CSV pour import staging"

# Mapping colonnes CSV → colonnes staging
$stagingColumns = @(
    "codgeo", "libgeo",
    "med21", "med20", "med19", "med18", "med17",
    "tp6021", "tp6020", "tp6019", "tp6018", "tp6017",
    "txpau21", "txpau20", "txpau19", "txpau18", "txpau17",
    "annee", "med", "txpau", "tp60"
)

# Trouver les indices des colonnes dans le CSV source
$colMapping = @{}
foreach ($sc in $stagingColumns) {
    $idx = [Array]::IndexOf($columns, $sc)
    if ($idx -ge 0) {
        $colMapping[$sc] = $idx
    }
}

# Vérifier qu'on a au moins codgeo
if (-not $colMapping.ContainsKey("codgeo")) {
    Write-Err "Colonne 'codgeo' introuvable dans le CSV. Colonnes: $($columns -join ', ')"
    exit 1
}

$mappedCols = $colMapping.Keys | Sort-Object
Write-Ok "Colonnes mappées: $($mappedCols -join ', ')"

# Créer le CSV intermédiaire (ne garder que les colonnes utiles, séparateur tab)
$tempCsv = [System.IO.Path]::GetTempFileName() + ".csv"
Write-Host "    Création du CSV intermédiaire: $tempCsv" -ForegroundColor DarkGray

$targetCols = $mappedCols | Sort-Object
$lineCount = 0

# Écrire le header
$targetCols -join "`t" | Out-File $tempCsv -Encoding UTF8

# Traiter ligne par ligne (streaming pour gros fichiers)
$reader = [System.IO.StreamReader]::new($csvFullPath, [System.Text.Encoding]::UTF8)
$writer = [System.IO.StreamWriter]::new($tempCsv, $true, [System.Text.Encoding]::UTF8)

# Skip header
$null = $reader.ReadLine()

while ($null -ne ($line = $reader.ReadLine())) {
    if ([string]::IsNullOrWhiteSpace($line)) { continue }

    # Parser la ligne (gestion basique des guillemets)
    $fields = $line.Split($csvSep)

    $outFields = @()
    foreach ($col in $targetCols) {
        $idx = $colMapping[$col]
        if ($idx -lt $fields.Count) {
            $val = $fields[$idx].Trim().Trim('"')
            $outFields += $val
        }
        else {
            $outFields += ""
        }
    }

    $writer.WriteLine($outFields -join "`t")
    $lineCount++

    if ($lineCount % 10000 -eq 0) {
        Write-Host "    ... $lineCount lignes traitées" -ForegroundColor DarkGray
    }
}

$reader.Close()
$writer.Close()

Write-Ok "$lineCount lignes préparées dans le CSV intermédiaire"

# ============================================================================
# Étape 3 : Exécuter la migration SQL (staging + indexes)
# ============================================================================
if (-not $SkipMigration) {
    Write-Step "Exécution de la migration SQL (staging + indexes + fonctions)"

    if (-not (Test-Path $MigrationPath)) {
        Write-Err "Fichier migration introuvable: $MigrationPath"
        Write-Err "Placez le fichier SQL ou spécifiez -MigrationPath"
        exit 1
    }

    & $PsqlPath $DatabaseUrl -f $MigrationPath -X -v ON_ERROR_STOP=1 2>&1 | ForEach-Object {
        if ($_ -match "^ERROR|^FATAL") {
            Write-Err $_
        }
        else {
            Write-Host "    $_" -ForegroundColor DarkGray
        }
    }

    if ($LASTEXITCODE -ne 0) {
        Write-Err "La migration SQL a échoué (code $LASTEXITCODE)"
        exit 1
    }
    Write-Ok "Migration exécutée avec succès"
}
else {
    Write-Step "Migration SQL ignorée (-SkipMigration)"
}

# ============================================================================
# Étape 4 : Vider le staging et importer via \copy
# ============================================================================
Write-Step "Import CSV → filosofi_staging via psql \copy"

# Vider le staging
Invoke-Psql -Sql "TRUNCATE public.filosofi_staging;"
Write-Ok "Staging vidé"

# Construire la commande \copy
$copyColumns = $targetCols -join ", "
$copySql = "\copy public.filosofi_staging($copyColumns) FROM '$($tempCsv.Replace('\', '/'))' WITH (FORMAT csv, HEADER true, DELIMITER E'\t', NULL '', ENCODING 'UTF8')"

Write-Host "    Commande: $copySql" -ForegroundColor DarkGray

# Exécuter le \copy via psql -c
& $PsqlPath $DatabaseUrl -X -c $copySql 2>&1 | ForEach-Object {
    if ($_ -match "^ERROR|^FATAL") {
        Write-Err $_
    }
    else {
        Write-Host "    $_" -ForegroundColor DarkGray
    }
}

if ($LASTEXITCODE -ne 0) {
    Write-Err "\copy a échoué (code $LASTEXITCODE)"
    exit 1
}

# Vérifier le count staging
$stagingCount = Invoke-Psql -Sql "SELECT count(*) FROM public.filosofi_staging;" -ReturnOutput
Write-Ok "Staging: $stagingCount lignes importées"

if ([int]$stagingCount -eq 0) {
    Write-Err "Le staging est vide ! Vérifiez le format CSV et le mapping des colonnes."
    exit 1
}

# ============================================================================
# Étape 5 : Transform + UPSERT
# ============================================================================
Write-Step "Transformation et UPSERT vers insee_socioeco_communes"

$importResult = Invoke-Psql -Sql "SELECT public.filosofi_run_import();" -ReturnOutput
Write-Ok $importResult

# ============================================================================
# Étape 6 : Validation
# ============================================================================
Write-Step "Validation post-import"

# 6a. Count total
$totalCommunes = Invoke-Psql -Sql @"
SELECT count(DISTINCT code_commune) AS nb
FROM public.insee_socioeco_communes
WHERE source = 'FILOSOFI';
"@ -ReturnOutput
Write-Ok "Communes distinctes (FILOSOFI): $totalCommunes"

# 6b. Total lignes
$totalRows = Invoke-Psql -Sql @"
SELECT count(*) FROM public.insee_socioeco_communes WHERE source = 'FILOSOFI';
"@ -ReturnOutput
Write-Ok "Total lignes (FILOSOFI): $totalRows"

# 6c. Count dept 92
$count92 = Invoke-Psql -Sql @"
SELECT count(*) FROM public.insee_socioeco_communes
WHERE left(code_commune, 2) = '92' AND source = 'FILOSOFI';
"@ -ReturnOutput
Write-Ok "Lignes dept 92: $count92"

# 6d. Vérif Neuilly
$neuilly = Invoke-Psql -Sql @"
SELECT code_commune, commune, annee, revenu_median_eur, taux_pauvrete_pct
FROM public.insee_socioeco_communes
WHERE code_commune = '92051'
ORDER BY annee DESC;
"@ -ReturnOutput

if ($neuilly) {
    Write-Ok "Neuilly-sur-Seine (92051):"
    Write-Host "    $neuilly" -ForegroundColor White
}
else {
    Write-Warn "Neuilly (92051) non trouvé dans les données importées"
}

# 6e. Top 10 revenus
Write-Host ""
Write-Host "    Top 10 communes par revenu médian:" -ForegroundColor White
$top10 = Invoke-Psql -Sql @"
SELECT code_commune, coalesce(commune, '?') AS commune,
       annee, revenu_median_eur
FROM public.insee_socioeco_communes
WHERE source = 'FILOSOFI' AND revenu_median_eur IS NOT NULL
ORDER BY revenu_median_eur DESC
LIMIT 10;
"@ -ReturnOutput
Write-Host "    $top10" -ForegroundColor White

# 6f. Distribution par année
Write-Host ""
$byYear = Invoke-Psql -Sql @"
SELECT annee, count(*) AS nb_lignes, count(DISTINCT code_commune) AS nb_communes,
       round(avg(revenu_median_eur)) AS rev_median_moy
FROM public.insee_socioeco_communes
WHERE source = 'FILOSOFI'
GROUP BY annee ORDER BY annee DESC;
"@ -ReturnOutput
Write-Host "    Distribution par année:" -ForegroundColor White
Write-Host "    $byYear" -ForegroundColor White

# ============================================================================
# Nettoyage
# ============================================================================
Write-Step "Nettoyage"

Remove-Item $tempCsv -ErrorAction SilentlyContinue
Write-Ok "CSV temporaire supprimé"

# Optionnel : drop staging
$dropStaging = Invoke-Psql -Sql "DROP TABLE IF EXISTS public.filosofi_staging;" -ReturnOutput
Write-Ok "Table staging supprimée"

# ============================================================================
# Résumé final
# ============================================================================
$elapsed = (Get-Date) - $StartTime
Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "  IMPORT TERMINÉ EN $([math]::Round($elapsed.TotalSeconds, 1))s" -ForegroundColor Green
Write-Host "  Communes: $totalCommunes | Lignes: $totalRows" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""