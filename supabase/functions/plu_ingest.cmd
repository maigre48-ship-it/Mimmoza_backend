curl.exe -X POST "https://fwvrqngbafqdaekbdfnm.functions.supabase.co/plu-ingest-from-storage" ^
  -H "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ3dnJxbmdiYWZxZGFla2JkZm5tIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MjY2ODU3OCwiZXhwIjoyMDc4MjQ0NTc4fQ.ZdDIs1BtQ7xNbhuG9AByQXV4LXGNF2VFkj9Mnnt1nGQ" ^
  -H "Content-Type: application/json" ^
  -d "{\"commune_insee\": \"64065\"}"
