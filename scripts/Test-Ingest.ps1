<#
.SYNOPSIS
    Manual test harness for POST /api/ingest/lead.

.DESCRIPTION
    Everything the endpoint needs to be exercised by hand, in one file, so there
    are no pasted function definitions to lose when you open a new terminal.

    Prints the HTTP status, the parsed JSON body, and — when the body is not
    JSON — the raw response text, so a failure is never silent.

.PARAMETER Test
    Which test to run. Default 'all'.
      valid      (a) a well-formed request; expect 201
      duplicate  (b) the same request twice; expect 201 then 200
      badkey     (c) wrong key and missing header; expect 401 twice
      malformed  (d) a payload that fails validation; expect 400
      all        every one of the above

.PARAMETER Key
    The raw API key. Defaults to the local test key from docs/INGEST_API.md.

.PARAMETER Url
    Endpoint URL. Defaults to the local dev server.

.EXAMPLE
    .\scripts\Test-Ingest.ps1

.EXAMPLE
    .\scripts\Test-Ingest.ps1 -Test valid

.EXAMPLE
    .\scripts\Test-Ingest.ps1 -Key 'zlk_...' -Url 'https://your-app.vercel.app/api/ingest/lead'

    With no -Url, the script probes localhost ports 3000-3003 and uses the first
    one that is actually serving this route (identified by the X-Ingest-Route
    response header, not merely by something answering on the port).

.NOTES
    If PowerShell refuses to run this file ("running scripts is disabled on this
    system"), either run it as:
        powershell -ExecutionPolicy Bypass -File .\scripts\Test-Ingest.ps1
    or allow local scripts for your user, once:
        Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
#>

[CmdletBinding()]
param(
    [ValidateSet('all', 'valid', 'duplicate', 'badkey', 'malformed')]
    [string]$Test = 'all',

    [string]$Key = 'zlk_local_test_only_00000000000000000000',

    # Empty by default: the port is DISCOVERED rather than assumed. `next dev`
    # silently moves to 3001, 3002... when 3000 is taken, and testing against a
    # hardcoded 3000 then means testing whatever else grabbed that port — which
    # answers with its own errors, in its own format, and logs to its own
    # terminal. That failure mode reads exactly like "our route returned a 500
    # with no body and logged nothing", and it has cost real debugging time.
    # Pass -Url explicitly to skip discovery (required for a deployed URL).
    [string]$Url = ''
)

$ErrorActionPreference = 'Stop'

# -----------------------------------------------------------------------------
# Request helper
# -----------------------------------------------------------------------------
# Invoke-WebRequest throws on any non-2xx, which makes testing a 401 or a 500
# awkward. This catches that and returns the status and body either way.
#
# Reading the body back is version-dependent and this is the part that bit us:
# PowerShell 7 populates $_.ErrorDetails.Message, Windows PowerShell 5.1 often
# does not. When 5.1 leaves it empty the response looks like it was empty, which
# is badly misleading. The stream fallback below covers that case.
function Invoke-Ingest {
    param([string]$ApiKey, [string]$Body, [string]$Endpoint)

    $headers = @{}
    if ($ApiKey) { $headers['Authorization'] = "Bearer $ApiKey" }

    $status  = 0
    $raw     = $null
    $fromUs  = $false

    try {
        $r = Invoke-WebRequest -Uri $Endpoint -Method Post -Headers $headers `
             -ContentType 'application/json' `
             -Body ([Text.Encoding]::UTF8.GetBytes($Body)) `
             -UseBasicParsing -ErrorAction Stop
        $status = [int]$r.StatusCode
        $raw    = $r.Content
        $fromUs = [bool]$r.Headers['X-Ingest-Route']
    }
    catch {
        if ($_.Exception.Response) {
            try { $status = [int]$_.Exception.Response.StatusCode } catch {}
            # The route stamps this on EVERY response it produces, success or
            # failure. Its absence means the reply came from something that is
            # not this route: another app on the port, or Next's own HTML error
            # page from a module that failed to load before the handler ran.
            try { $fromUs = [bool]$_.Exception.Response.Headers['X-Ingest-Route'] } catch {}
        }
        if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
            $raw = $_.ErrorDetails.Message
        }
        if (-not $raw -and $_.Exception.Response) {
            try {
                $rs = $_.Exception.Response.GetResponseStream()
                # Only rewind a stream that can be rewound. PowerShell 5.1 hands
                # back a seekable SyncMemoryStream for small buffered replies but
                # a forward-only ConnectStream for larger or chunked ones, and
                # setting Position on that throws — losing the body and making a
                # perfectly informative error look like an empty response.
                if ($rs.CanSeek) { $rs.Position = 0 }
                $sr  = New-Object System.IO.StreamReader($rs)
                $raw = $sr.ReadToEnd()
                $sr.Close()
            } catch {
                $raw = "<could not read response body: $($_.Exception.Message)>"
            }
        }
        # No response at all: server down, wrong port, connection refused.
        if (-not $raw) {
            $raw = "<no response; transport error: $($_.Exception.Message)>"
        }
    }

    $parsed = $null
    if ($raw) { try { $parsed = $raw | ConvertFrom-Json } catch {} }

    [pscustomobject]@{
        Status        = $status
        Body          = $parsed
        Raw           = $raw
        FromIngestRoute = $fromUs
    }
}

# -----------------------------------------------------------------------------
# Where is the server?
# -----------------------------------------------------------------------------
# Answers "is /api/ingest/lead being served here?" without side effects, using
# the OPTIONS probe the route exposes. A plain "is the port open?" check is not
# good enough — the whole problem is that SOMETHING is usually listening.
function Test-IngestEndpoint {
    param([string]$Endpoint)
    try {
        $r = Invoke-WebRequest -Uri $Endpoint -Method Options -UseBasicParsing `
             -TimeoutSec 3 -ErrorAction Stop
        return [bool]$r.Headers['X-Ingest-Route']
    } catch {
        try { return [bool]$_.Exception.Response.Headers['X-Ingest-Route'] } catch { return $false }
    }
}

function Find-IngestUrl {
    foreach ($port in 3000, 3001, 3002, 3003) {
        $candidate = "http://localhost:$port/api/ingest/lead"
        if (Test-IngestEndpoint $candidate) { return $candidate }
    }
    return $null
}

# -----------------------------------------------------------------------------
# Output
# -----------------------------------------------------------------------------
$script:Passed = 0
$script:Failed = 0

function Write-Result {
    param([string]$Label, [int]$Expected, $Response)

    $ok = $Response.Status -eq $Expected
    if ($ok) { $script:Passed++ } else { $script:Failed++ }

    $mark  = if ($ok) { '[PASS]' } else { '[FAIL]' }
    $color = if ($ok) { 'Green' } else { 'Red' }

    Write-Host ""
    Write-Host "$mark $Label" -ForegroundColor $color
    Write-Host "       expected $Expected, got $($Response.Status)"

    # The single most useful line in this script when things are confusing.
    # A status with no X-Ingest-Route header did not come from our handler, so
    # nothing about it — not the code, not the body, not the absence of a body,
    # not the silent dev-server terminal — says anything about our code.
    if (-not $Response.FromIngestRoute -and $Response.Status -ne 0) {
        Write-Host "       !! This response did NOT come from /api/ingest/lead." -ForegroundColor Red
        Write-Host "          It has no X-Ingest-Route header, so it came from another" -ForegroundColor Red
        Write-Host "          process on this port, or from Next's own error page before" -ForegroundColor Red
        Write-Host "          the handler ran. Check the port your dev server printed." -ForegroundColor Red
    }

    if ($Response.Body) {
        if ($Response.Body.error) {
            Write-Host "       code    : $($Response.Body.error.code)" -ForegroundColor Yellow
            Write-Host "       message : $($Response.Body.error.message)"
            if ($Response.Body.error.details) {
                foreach ($d in $Response.Body.error.details) {
                    Write-Host "       detail  : $d"
                }
            }
            # Present outside production only. This is where the underlying
            # cause of a 500 shows up.
            if ($Response.Body.error.debug) {
                Write-Host "       debug   : $($Response.Body.error.debug)" -ForegroundColor Magenta
            }
        }
        else {
            Write-Host "       status      : $($Response.Body.status)"
            Write-Host "       duplicate   : $($Response.Body.duplicate)"
            Write-Host "       lead_id     : $($Response.Body.lead_id)"

            # Only the 'created' response carries assignment fields. A duplicate
            # writes nothing, so it has no assigned_to to report - and printing
            # "(null - no active users in this org)" there is simply false. That
            # is the kind of confidently wrong diagnostic that sends someone
            # looking for a staffing problem that does not exist.
            if ($Response.Body.status -eq 'created') {
                if ($null -ne $Response.Body.assigned_to) {
                    Write-Host "       assigned_to : $($Response.Body.assigned_to)"
                } else {
                    Write-Host "       assigned_to : (null - no active users in this org)" -ForegroundColor Yellow
                }
                Write-Host "       lead_status : $($Response.Body.lead_status)"
            }
        }
        Write-Host "       request_id  : $($Response.Body.request_id)" -ForegroundColor DarkGray
    }
    else {
        # Not JSON. Usually an HTML error page, meaning the request never
        # reached the route handler at all.
        Write-Host "       (response was not JSON) raw:" -ForegroundColor Yellow
        $preview = $Response.Raw
        if ($preview.Length -gt 400) { $preview = $preview.Substring(0, 400) + ' ...[truncated]' }
        Write-Host "       $preview" -ForegroundColor DarkGray
    }
}

# -----------------------------------------------------------------------------
# Payloads
# -----------------------------------------------------------------------------
# A fresh source_message_id per run, so re-running the script does not simply
# hit the idempotency path every time. The duplicate test reuses one on purpose.
$stamp = Get-Date -Format 'yyyyMMddHHmmss'

function New-Payload {
    param([string]$MessageId)
    @"
{
  "channel": "instagram",
  "source": "manychat",
  "source_message_id": "$MessageId",
  "lead": { "name": "Ananya Rao", "phone": "+91 98200 33333" },
  "ai_qualification": {
    "score": 88,
    "summary": "Wants to train 4x a week before summer. Budget confirmed at 6000/month.",
    "fields": { "goal": "weight_loss", "budget_month": "6000", "start_when": "this_month" }
  },
  "conversation": {
    "messages": [
      { "sender": "lead", "text": "hi, do you do 1-on-1 sessions?", "timestamp": "2026-03-08T10:02:00Z" },
      { "sender": "ai", "text": "We do! What is your main goal right now?", "timestamp": "2026-03-08T10:02:14Z" },
      { "sender": "lead", "text": "want to lose weight before summer, 4x a week", "timestamp": "2026-03-08T10:03:31Z" }
    ]
  }
}
"@
}

$malformed = '{"channel":"telegram","source":"manychat","lead":{},"ai_qualification":{"score":150,"fields":{}},"conversation":{"messages":[]}}'

# -----------------------------------------------------------------------------
# Run
# -----------------------------------------------------------------------------
if (-not $Url) {
    Write-Host ""
    Write-Host "No -Url given; looking for the dev server..." -ForegroundColor DarkGray
    $Url = Find-IngestUrl

    if (-not $Url) {
        Write-Host ""
        Write-Host "Could not find /api/ingest/lead on localhost ports 3000-3003." -ForegroundColor Red
        Write-Host "Start it with 'npm run dev', note the port it prints (it moves off" -ForegroundColor Red
        Write-Host "3000 when that port is taken), then pass it explicitly:" -ForegroundColor Red
        Write-Host "    .\scripts\Test-Ingest.ps1 -Url 'http://localhost:3001/api/ingest/lead'" -ForegroundColor Red
        exit 1
    }
}
elseif (-not (Test-IngestEndpoint $Url)) {
    # Not fatal: an explicit -Url is the user's decision, and a deployment
    # behind a proxy that strips headers is a legitimate reason to see this.
    Write-Host ""
    Write-Host "Warning: $Url did not identify itself as the ingest route." -ForegroundColor Yellow
    Write-Host "Anything that answers may not be this app. Continuing anyway." -ForegroundColor Yellow
}

Write-Host ""
Write-Host "POST $Url" -ForegroundColor Cyan
Write-Host "key  $($Key.Substring(0, [Math]::Min(12, $Key.Length)))..." -ForegroundColor DarkGray
Write-Host "PowerShell $($PSVersionTable.PSVersion)" -ForegroundColor DarkGray

if ($Test -in @('all', 'valid')) {
    $r = Invoke-Ingest -ApiKey $Key -Body (New-Payload "ig_msg_$stamp`_a") -Endpoint $Url
    Write-Result -Label '(a) valid request creates a lead' -Expected 201 -Response $r
}

if ($Test -in @('all', 'duplicate')) {
    $dupId   = "ig_msg_$stamp`_dup"
    $payload = New-Payload $dupId

    $first = Invoke-Ingest -ApiKey $Key -Body $payload -Endpoint $Url
    Write-Result -Label '(b1) first send creates the lead' -Expected 201 -Response $first

    $second = Invoke-Ingest -ApiKey $Key -Body $payload -Endpoint $Url
    Write-Result -Label '(b2) identical resend is idempotent' -Expected 200 -Response $second

    if ($first.Body.lead_id -and $second.Body.lead_id) {
        if ($first.Body.lead_id -eq $second.Body.lead_id) {
            Write-Host "       same lead_id returned - no duplicate created" -ForegroundColor Green
        } else {
            Write-Host "       DIFFERENT lead_id - a duplicate WAS created" -ForegroundColor Red
            $script:Failed++
        }
    }
}

if ($Test -in @('all', 'badkey')) {
    $r1 = Invoke-Ingest -ApiKey 'zlk_definitely_not_a_real_key' -Body (New-Payload "ig_msg_$stamp`_c1") -Endpoint $Url
    Write-Result -Label '(c1) wrong API key is rejected' -Expected 401 -Response $r1

    $r2 = Invoke-Ingest -ApiKey '' -Body (New-Payload "ig_msg_$stamp`_c2") -Endpoint $Url
    Write-Result -Label '(c2) missing Authorization header is rejected' -Expected 401 -Response $r2
}

if ($Test -in @('all', 'malformed')) {
    $r = Invoke-Ingest -ApiKey $Key -Body $malformed -Endpoint $Url
    Write-Result -Label '(d) malformed payload is rejected with field detail' -Expected 400 -Response $r
}

Write-Host ""
Write-Host ("-" * 60)
$summaryColor = if ($script:Failed -eq 0) { 'Green' } else { 'Red' }
Write-Host "passed $script:Passed   failed $script:Failed" -ForegroundColor $summaryColor
Write-Host ""

if ($script:Failed -gt 0) {
    Write-Host "If a 500 came back, read the 'debug' line above - it names the cause." -ForegroundColor Yellow
    Write-Host "The dev server terminal also prints one headline line per failure." -ForegroundColor Yellow
    Write-Host ""
    exit 1
}
