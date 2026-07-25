from typing import Optional, Dict, Any, List
import urllib.parse
import os
import requests
import json
from crewai.tools import BaseTool
from pydantic import BaseModel, Field
import sys


DEFAULT_BACKEND_URLS = [
    os.getenv("BACKEND_API_URL"),
    os.getenv("BANK_BACKEND_URL"),
    "http://localhost:3001",
    "http://localhost:3000",
]


def _pick_backend_base() -> Optional[str]:
    urls = [
        os.getenv("BACKEND_API_URL"),
        os.getenv("BANK_BACKEND_URL"),
        "http://localhost:3001",
        "http://localhost:3000",
    ]

    print(f"DEBUG: Available backend URLs: {urls}", file=sys.stderr)

    for u in urls:
        if u:
            result = u.rstrip("/")
            print(f"DEBUG: Selected backend URL: {result}", file=sys.stderr)
            return result

    print("DEBUG: No backend URL found", file=sys.stderr)
    return None


def _auth_headers() -> Dict[str, str]:
    token = os.getenv("BACKEND_JWT") or os.getenv("BANK_API_TOKEN")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
        print("DEBUG: JWT token present", file=sys.stderr)
    else:
        print("DEBUG: No JWT token found", file=sys.stderr)
    return headers


class FinancialInfoInput(BaseModel):
    """Inputs for fetching company financial information."""
    topic: str = Field(
        ..., description="Topic to fetch, e.g., 'summary', 'accounts', 'outstanding', 'balance', 'audit'"
    )
    client_ein: Optional[str] = Field(
        default=None, description="Client EIN; if not provided, reads CLIENT_EIN from env"
    )


class LedgerQueryInput(BaseModel):
    """Inputs for querying ledger data for financial analysis and charts."""
    query_type: str = Field(
        ..., description="Type of query: 'summary' (account summaries), 'balances' (account balances), 'entries' (ledger entries)"
    )
    start_date: Optional[str] = Field(
        default=None, description="Start date in YYYY-MM-DD format"
    )
    end_date: Optional[str] = Field(
        default=None, description="End date in YYYY-MM-DD format"
    )
    account_codes: Optional[str] = Field(
        default=None, description="Comma-separated list of account codes to filter by"
    )
    client_ein: Optional[str] = Field(
        default=None, description="Client EIN; if not provided, reads CLIENT_EIN from env"
    )


class CompanyFinancialInfoTool(BaseTool):
    name: str = "company_financial_info"
    description: str = (
        "Fetch company financial info for the current client (EIN) from the Finova backend. "
        "Supports topics: summary, accounts, outstanding, balance, audit."
    )
    # Pydantic v2 requires annotated override for class attributes inherited from BaseModel-based parents
    args_schema: type[FinancialInfoInput] = FinancialInfoInput

    def _run(self, topic: str, client_ein: Optional[str] = None) -> str:
        base = _pick_backend_base()
        headers = _auth_headers()
        ein = client_ein or os.getenv("CLIENT_EIN")

        if not ein:
            return "No client EIN available. Provide client_ein or set CLIENT_EIN in environment."
        if not base:
            return "Backend base URL not configured. Set BACKEND_API_URL or BANK_BACKEND_URL."
        if "Authorization" not in headers:
            return "No backend JWT available. Set BACKEND_JWT in environment."

        try:
            if topic.lower() == "accounts":
                url = f"{base}/bank/{ein}/accounts"
                r = requests.get(url, headers=headers, timeout=15)
                r.raise_for_status()
                data = r.json()
                return json.dumps({"accounts": data}, ensure_ascii=False)

            if topic.lower() == "summary":
                url = f"{base}/bank/{ein}/reports/summary"
                r = requests.get(url, headers=headers, timeout=20)
                r.raise_for_status()
                return json.dumps(r.json(), ensure_ascii=False)

            if topic.lower() == "outstanding":
                url = f"{base}/bank/{ein}/reports/outstanding-items"
                r = requests.get(url, headers=headers, timeout=20)
                r.raise_for_status()
                return json.dumps(r.json(), ensure_ascii=False)

            if topic.lower() == "balance":
                # Example: current month by default; backend may infer defaults if not provided
                url = f"{base}/bank/{ein}/balance-reconciliation"
                r = requests.get(url, headers=headers, timeout=20)
                r.raise_for_status()
                return json.dumps(r.json(), ensure_ascii=False)

            if topic.lower() == "audit":
                url = f"{base}/bank/{ein}/reports/audit-trail?page=1&size=20"
                r = requests.get(url, headers=headers, timeout=20)
                r.raise_for_status()
                return json.dumps(r.json(), ensure_ascii=False)

            return (
                "Unknown topic. Use one of: summary, accounts, outstanding, balance, audit."
            )
        except requests.exceptions.RequestException:
            return "Backend temporarily unavailable or network error."
        except Exception as e:
            return f"Error fetching financial info: {str(e)}"


class LedgerQueryTool(BaseTool):
    name: str = "query_ledger"
    description: str = (
        "Query ledger data for financial analysis. Use this when users ask about financial data, "
        "account balances, revenue, expenses, or want to see financial charts. "
        "Supports query types: 'summary' (account summaries with monthly breakdown), "
        "'balances' (current account balances), 'entries' (detailed ledger entries)."
    )
    args_schema: type[LedgerQueryInput] = LedgerQueryInput

    def _run(
        self,
        query_type: str,
        start_date: Optional[str] = None,
        end_date: Optional[str] = None,
        account_codes: Optional[str] = None,
        client_ein: Optional[str] = None,
    ) -> str:
        base = _pick_backend_base()
        headers = _auth_headers()
        ein = client_ein or os.getenv("CLIENT_EIN")

        if not ein:
            return "No client EIN available. Provide client_ein or set CLIENT_EIN in environment."
        if not base:
            return "Backend base URL not configured. Set BACKEND_API_URL or BANK_BACKEND_URL."
        if "Authorization" not in headers:
            return "No backend JWT available. Set BACKEND_JWT in environment."

        try:
            if query_type.lower() == "summary":
                url = f"{base}/accounting/{ein}/ledger/summary"
                params = {}
                if start_date:
                    params["startDate"] = start_date
                if end_date:
                    params["endDate"] = end_date
                if params:
                    url += "?" + urllib.parse.urlencode(params)
                r = requests.get(url, headers=headers, timeout=30)
                r.raise_for_status()
                return json.dumps(r.json(), ensure_ascii=False)

            elif query_type.lower() == "balances":
                url = f"{base}/accounting/{ein}/ledger/balances"
                params = {}
                if start_date:
                    params["startDate"] = start_date
                if end_date:
                    params["endDate"] = end_date
                if account_codes:
                    params["accountCodes"] = account_codes
                if params:
                    url += "?" + urllib.parse.urlencode(params)
                r = requests.get(url, headers=headers, timeout=30)
                r.raise_for_status()
                return json.dumps(r.json(), ensure_ascii=False)

            elif query_type.lower() == "entries":
                url = f"{base}/accounting/{ein}/ledger"
                params = {"page": "1", "size": "100"}
                if start_date:
                    params["startDate"] = start_date
                if end_date:
                    params["endDate"] = end_date
                if account_codes:
                    params["accountCode"] = account_codes.split(",")[0]  # Use first code for entries
                url += "?" + urllib.parse.urlencode(params)
                r = requests.get(url, headers=headers, timeout=30)
                r.raise_for_status()
                return json.dumps(r.json(), ensure_ascii=False)

            return "Unknown query_type. Use one of: summary, balances, entries."
        except requests.exceptions.RequestException as e:
            return f"Backend temporarily unavailable or network error: {str(e)}"
        except Exception as e:
            return f"Error querying ledger: {str(e)}"


class UsersSearchInput(BaseModel):
    """Inputs for searching company users to resolve assignees."""
    query: Optional[str] = Field(default=None, description="Partial name or email to search for")
    limit: Optional[int] = Field(default=10, description="Max number of results to return")


class UsersSearchTool(BaseTool):
    name: str = "search_users"
    description: str = (
        "Search company users by name/email to resolve assignees. Returns closest matches."
    )
    args_schema: type[UsersSearchInput] = UsersSearchInput

    def _run(self, query: Optional[str] = None, limit: Optional[int] = 10) -> str:
        base = _pick_backend_base()
        headers = _auth_headers()
        if not base:
            return "Backend base URL not configured. Set BACKEND_API_URL or BANK_BACKEND_URL."
        if "Authorization" not in headers:
            return "No backend JWT available. Set BACKEND_JWT in environment."

        try:
            url = f"{base}/users/company"
            r = requests.get(url, headers=headers, timeout=15)
            r.raise_for_status()
            data = r.json()
            if not isinstance(data, list):
                return "Unexpected users payload from backend."

            users: List[Dict[str, Any]] = [
                {"id": u.get("id"), "name": u.get("name"), "email": u.get("email")}
                for u in data
            ]

            if not query:
                return json.dumps({"items": users[: (limit or 10)]}, ensure_ascii=False)

            # Fuzzy match locally (name/email)
            def norm(s: Optional[str]) -> str:
                return (s or "").strip().lower()

            q = norm(query)

            def levenshtein(a: str, b: str) -> int:
                m, n = len(a), len(b)
                if m == 0:
                    return n
                if n == 0:
                    return m
                dp = [[0] * (n + 1) for _ in range(m + 1)]
                for i in range(m + 1):
                    dp[i][0] = i
                for j in range(n + 1):
                    dp[0][j] = j
                for i in range(1, m + 1):
                    ca = a[i - 1]
                    for j in range(1, n + 1):
                        cost = 0 if ca == b[j - 1] else 1
                        dp[i][j] = min(
                            dp[i - 1][j] + 1,
                            dp[i][j - 1] + 1,
                            dp[i - 1][j - 1] + cost,
                        )
                return dp[m][n]

            scored: List[Dict[str, Any]] = []
            for u in users:
                n = norm(u.get("name"))
                e = norm(u.get("email"))
                # scores for name
                ns = (0 if n.startswith(q) else 1) * 100 + (0 if q in n else 1) * 10 + levenshtein(n, q)
                # scores for email
                es = (0 if e.startswith(q) else 1) * 100 + (0 if q in e else 1) * 10 + levenshtein(e, q)
                score = min(ns, es)
                scored.append({**u, "score": score})

            scored.sort(key=lambda x: x["score"])  # lower is better
            top = scored[: (limit or 10)]
            return json.dumps({"items": top}, ensure_ascii=False)
        except requests.exceptions.RequestException:
            return "Backend temporarily unavailable or network error."
        except Exception as e:
            return f"Error searching users: {str(e)}"


class CreateTodoInput(BaseModel):
    """Inputs for creating a new Todo task for the current client."""
    title: str = Field(..., description="Short title for the task")
    description: Optional[str] = Field(default=None, description="Detailed description")
    status: Optional[str] = Field(default=None, description="pending|in_progress|completed (optional)")
    priority: Optional[str] = Field(default=None, description="low|medium|high (optional)")
    dueDate: Optional[str] = Field(default=None, description="ISO date string YYYY-MM-DD (optional)")
    tags: Optional[List[str]] = Field(default=None, description="List of tags (optional)")
    assigneeIds: Optional[List[int]] = Field(default=None, description="List of user IDs to assign (optional)")
    assigneeNames: Optional[List[str]] = Field(default=None, description="List of user names to assign (optional)")
    assigneeEmails: Optional[List[str]] = Field(default=None, description="List of user emails to assign (optional)")
    relatedDocumentId: Optional[int] = Field(default=None, description="Related document ID (optional)")
    relatedTransactionId: Optional[str] = Field(default=None, description="Related bank transaction ID (optional)")
    client_ein: Optional[str] = Field(default=None, description="Client EIN; if not provided, reads CLIENT_EIN from env")


class CreateTodoTool(BaseTool):
    name: str = "create_todo"
    description: str = (
        "Create a new Todo task for the current client (EIN). Provide at minimum a title. "
        "Optional: description, dueDate (YYYY-MM-DD), priority (low|medium|high), status, tags, assigneeIds."
    )
    args_schema: type[CreateTodoInput] = CreateTodoInput

    def _run(
        self,
        title: str,
        description: Optional[str] = None,
        status: Optional[str] = None,
        priority: Optional[str] = None,
        dueDate: Optional[str] = None,
        tags: Optional[List[str]] = None,
        assigneeIds: Optional[List[int]] = None,
        assigneeNames: Optional[List[str]] = None,
        assigneeEmails: Optional[List[str]] = None,
        relatedDocumentId: Optional[int] = None,
        relatedTransactionId: Optional[str] = None,
        client_ein: Optional[str] = None,
    ) -> str:
        base = _pick_backend_base()
        headers = _auth_headers()
        ein = client_ein or os.getenv("CLIENT_EIN")

        if not ein:
            return "No client EIN available. Provide client_ein or set CLIENT_EIN in environment."
        if not base:
            return "Backend base URL not configured. Set BACKEND_API_URL or BANK_BACKEND_URL."
        if "Authorization" not in headers:
            return "No backend JWT available. Set BACKEND_JWT in environment."

        payload: Dict[str, Any] = {"title": title}
        # Propagate language preference explicitly if available
        lang = os.getenv("AGENT_LANG") or os.getenv("LANGUAGE") or os.getenv("APP_LANG") or os.getenv("BACKEND_LANGUAGE")
        if lang:
            payload["language"] = lang
        if description is not None:
            payload["description"] = description
        if status is not None:
            payload["status"] = status
        if priority is not None:
            payload["priority"] = priority
        if dueDate is not None:
            payload["dueDate"] = dueDate
        if tags is not None:
            payload["tags"] = tags
        if assigneeIds is not None:
            payload["assigneeIds"] = assigneeIds
        if assigneeNames is not None:
            payload["assigneeNames"] = assigneeNames
        if assigneeEmails is not None:
            payload["assigneeEmails"] = assigneeEmails
        if relatedDocumentId is not None:
            payload["relatedDocumentId"] = relatedDocumentId
        if relatedTransactionId is not None:
            payload["relatedTransactionId"] = relatedTransactionId

        try:
            url = f"{base}/todos/{ein}"
            r = requests.post(url, headers=headers, json=payload, timeout=20)
            # If backend returns non-2xx, raise and surface details
            try:
                r.raise_for_status()
            except requests.exceptions.HTTPError as he:
                # Include backend response text for easier debugging
                detail = r.text
                return f"Failed to create todo (HTTP {r.status_code}): {detail or str(he)}"

            # Parse response and ensure it contains an ID
            try:
                data = r.json()
            except Exception:
                data = None

            if isinstance(data, dict) and data.get("id"):
                return json.dumps({"success": True, "item": data}, ensure_ascii=False)

            # Fallback verification: search recent todos by title to confirm creation
            try:
                q = urllib.parse.quote(title)
                list_url = f"{base}/todos/{ein}?q={q}&size=5"
                lr = requests.get(list_url, headers=headers, timeout=15)
                if lr.ok:
                    listing = lr.json() if lr.content else {}
                    items = (listing or {}).get("items") or []
                    # Try to find an exact title match (optionally description if provided)
                    match = None
                    for it in items:
                        if it.get("title") == title:
                            if description is None or it.get("description") == description:
                                match = it
                                break
                    if match and match.get("id"):
                        return json.dumps({"success": True, "item": match, "note": "verified via list fallback"}, ensure_ascii=False)
            except Exception:
                # Ignore fallback errors, proceed to final failure
                pass

            return json.dumps({
                "success": False,
                "error": "Create may have failed: backend did not return an ID and verification couldn't confirm the item.",
                "request": payload,
            }, ensure_ascii=False)
        except requests.exceptions.RequestException as e:
            return f"Failed to create todo: {str(e)}"
        except Exception as e:
            return f"Error creating todo: {str(e)}"


class CreateClientTaskInput(BaseModel):
    """Inputs for creating a client task (visible in client portal). Use this when the user asks to create a task for the client / for a person like Leo."""
    title: str = Field(..., description="Title of the task")
    description: Optional[str] = Field(default=None, description="Optional description")
    dueDate: Optional[str] = Field(default=None, description="Due date YYYY-MM-DD (optional)")
    client_ein: Optional[str] = Field(default=None, description="Client company EIN; if not provided, uses CLIENT_EIN from env")


class CreateClientTaskTool(BaseTool):
    name: str = "create_client_task"
    description: str = (
        "Create a task for the CLIENT (visible in client portal). Use this when the user asks to create a task "
        "'for the client', 'for Leo', 'pentru client', etc. Provide title; optional description and dueDate (YYYY-MM-DD). "
        "Uses current client EIN from context if client_ein not provided."
    )
    args_schema: type[CreateClientTaskInput] = CreateClientTaskInput

    def _run(
        self,
        title: str,
        description: Optional[str] = None,
        dueDate: Optional[str] = None,
        client_ein: Optional[str] = None,
    ) -> str:
        base = _pick_backend_base()
        headers = _auth_headers()
        ein = (client_ein or os.getenv("CLIENT_EIN") or "").strip().replace(" ", "")
        if not ein:
            return "No client EIN available. Provide client_ein or set CLIENT_EIN in environment."
        if not base:
            return "Backend base URL not configured. Set BACKEND_API_URL or BANK_BACKEND_URL."
        if "Authorization" not in headers:
            return "No backend JWT available. Set BACKEND_JWT in environment."
        payload: Dict[str, Any] = {"clientEin": ein, "title": title}
        if description is not None:
            payload["description"] = description
        if dueDate is not None:
            payload["dueDate"] = dueDate
        try:
            url = f"{base}/client-portal/tasks-by-ein"
            r = requests.post(url, headers=headers, json=payload, timeout=20)
            try:
                r.raise_for_status()
            except requests.exceptions.HTTPError as he:
                return f"Failed to create client task (HTTP {r.status_code}): {r.text or str(he)}"
            data = r.json() if r.content else None
            if isinstance(data, dict) and data.get("id"):
                return json.dumps({"success": True, "task": data}, ensure_ascii=False)
            return json.dumps({"success": True, "response": data}, ensure_ascii=False)
        except requests.exceptions.RequestException as e:
            return f"Failed to create client task: {str(e)}"
        except Exception as e:
            return f"Error creating client task: {str(e)}"


class QueryTodosInput(BaseModel):
    status: Optional[str] = None
    priority: Optional[str] = None
    q: Optional[str] = None
    dueFrom: Optional[str] = None
    dueTo: Optional[str] = None
    assigneeIds: Optional[str] = None
    tags: Optional[str] = None
    page: Optional[int] = 1
    size: Optional[int] = 25
    client_ein: Optional[str] = None


class QueryTodosTool(BaseTool):
    name: str = "query_todos"
    description: str = (
        "Query existing todo tasks for the current client (EIN). "
        "Use this to answer questions about what tasks need to be done, what's completed, what's pending, "
        "what's due, deadlines, task status, priorities, etc. "
        "Supports filtering by status (PENDING, IN_PROGRESS, COMPLETED), priority (LOW, MEDIUM, HIGH), "
        "search query (q), due dates (dueFrom, dueTo), assignees, and tags."
    )
    args_schema: type[QueryTodosInput] = QueryTodosInput

    def _run(
        self,
        status: Optional[str] = None,
        priority: Optional[str] = None,
        q: Optional[str] = None,
        dueFrom: Optional[str] = None,
        dueTo: Optional[str] = None,
        assigneeIds: Optional[str] = None,
        tags: Optional[str] = None,
        page: Optional[int] = 1,
        size: Optional[int] = 25,
        client_ein: Optional[str] = None,
    ) -> str:

        base = _pick_backend_base()
        headers = _auth_headers()
        ein = client_ein or os.getenv("CLIENT_EIN")

        if not ein:
            return "No client EIN available."
        if not base:
            return "Backend base URL not configured."
        if "Authorization" not in headers:
            return "No backend JWT available."

        params = {
            "page": str(page or 1),
            "size": str(size or 25),
        }

        if status:
            params["status"] = status
        if priority:
            params["priority"] = priority
        if q:
            params["q"] = q
        if dueFrom:
            params["dueFrom"] = dueFrom
        if dueTo:
            params["dueTo"] = dueTo
        if assigneeIds:
            params["assigneeIds"] = assigneeIds
        if tags:
            params["tags"] = tags

        try:
            url = f"{base}/todos/{ein}?" + urllib.parse.urlencode(params)
            r = requests.get(url, headers=headers, timeout=20)
            r.raise_for_status()
            return json.dumps(r.json(), ensure_ascii=False)
        except requests.exceptions.RequestException:
            return "Backend temporarily unavailable or network error."
        except Exception as e:
            return f"Error querying todos: {str(e)}"


class QueryClientTasksInput(BaseModel):
    """Inputs for querying client tasks (tasks assigned to the client by the accountant)."""
    client_ein: Optional[str] = Field(default=None, description="Client company EIN; if not provided, uses CLIENT_EIN from env")


class QueryClientTasksTool(BaseTool):
    name: str = "query_client_tasks"
    description: str = (
        "Get the list of tasks that the CLIENT has received from the accountant (sarcini primite de la contabil). "
        "Use this when the user (in client view) asks: 'care sunt task-urile pe care le-am primit de la contabil?', "
        "'what tasks did I receive from the accountant?', etc. Returns tasks with title, description, dueDate, status."
    )
    args_schema: type[QueryClientTasksInput] = QueryClientTasksInput

    def _run(self, client_ein: Optional[str] = None) -> str:
        base = _pick_backend_base()
        headers = _auth_headers()
        ein = (client_ein or os.getenv("CLIENT_EIN") or "").strip().replace(" ", "")
        if not ein:
            return "No client EIN available. Provide client_ein or set CLIENT_EIN in environment."
        if not base:
            return "Backend base URL not configured."
        if "Authorization" not in headers:
            return "No backend JWT available."
        try:
            url = f"{base}/client-portal/tasks-by-ein?clientEin={urllib.parse.quote(ein)}"
            r = requests.get(url, headers=headers, timeout=20)
            r.raise_for_status()
            data = r.json() if r.content else {}
            return json.dumps(data, ensure_ascii=False)
        except requests.exceptions.HTTPError as e:
            return f"Failed to get client tasks (HTTP {e.response.status_code if e.response else '?'}): {e.response.text if e.response else str(e)}"
        except Exception as e:
            return f"Error querying client tasks: {str(e)}"


class SearchDocumentsInput(BaseModel):
    """Inputs for searching documents via the Finova backend /files/search endpoint."""
    company: str = Field(..., description="Company EIN or name to search in")
    q: Optional[str] = Field(default=None, description="Free text: vendor/supplier name (e.g. Autolak), invoice number, etc.")
    type: Optional[str] = Field(default=None, description="Document type filter (e.g., Invoice, Receipt)")
    paymentStatus: Optional[str] = Field(default=None, description="Payment status filter")
    dateFrom: Optional[str] = Field(default=None, description="Start date YYYY-MM-DD")
    dateTo: Optional[str] = Field(default=None, description="End date YYYY-MM-DD")
    page: Optional[int] = Field(default=1, description="Page number (1-based)")
    limit: Optional[int] = Field(default=25, description="Page size")
    sort: Optional[str] = Field(default="createdAt_desc", description="Sort key, e.g., createdAt_desc")


class SearchDocumentsTool(BaseTool):
    name: str = "search_documents"
    description: str = (
        "Search company documents by company name/EIN, text, type, dates, and payment status. "
        "Returns items with signedUrl for direct PDF rendering."
    )
    args_schema: type[SearchDocumentsInput] = SearchDocumentsInput

    def _run(
        self,
        company: str,
        q: Optional[str] = None,
        type: Optional[str] = None,
        paymentStatus: Optional[str] = None,
        dateFrom: Optional[str] = None,
        dateTo: Optional[str] = None,
        page: Optional[int] = 1,
        limit: Optional[int] = 25,
        sort: Optional[str] = "createdAt_desc",
    ) -> str:
        base = _pick_backend_base()
        headers = _auth_headers()
        if not base:
            return "Backend base URL not configured. Set BACKEND_API_URL or BANK_BACKEND_URL."
        if "Authorization" not in headers:
            return "No backend JWT available. Set BACKEND_JWT in environment."

        try:
            params = {
                "company": company,
                "page": str(page or 1),
                "limit": str(limit or 25),
                "sort": sort or "createdAt_desc",
            }
            if q:
                params["q"] = q
            if type:
                params["type"] = type
            if paymentStatus:
                params["paymentStatus"] = paymentStatus
            if dateFrom:
                params["dateFrom"] = dateFrom
            if dateTo:
                params["dateTo"] = dateTo

            url = f"{base}/files/search?" + urllib.parse.urlencode(params)
            # Never log headers (they carry the Bearer JWT) and keep debug on stderr
            # so it can't pollute the stdout response stream parsed by the Node layer.
            print(f"🔍 SEARCH DEBUG: URL={url}", file=sys.stderr)
            print(f"🔍 SEARCH DEBUG: Params={params}", file=sys.stderr)

            r = requests.get(url, headers=headers, timeout=20)
            print(f"🔍 SEARCH DEBUG: Status={r.status_code}", file=sys.stderr)
            print(f"🔍 SEARCH DEBUG: Response={r.text[:500]}...", file=sys.stderr)

            r.raise_for_status()
            data = r.json()
            # Return ONLY the items array so the agent can echo it verbatim; frontend expects array.
            items = (data or {}).get("items") or (data or {}).get("documents") or []
            print(f"🔍 SEARCH DEBUG: Returning {len(items)} items (array only)", file=sys.stderr)
            return json.dumps(items, ensure_ascii=False)
        except requests.exceptions.RequestException:
            return "Backend temporarily unavailable or network error."
        except Exception as e:
            return f"Error searching documents: {str(e)}"


class SendMessageInput(BaseModel):
    content: str
    client_ein: Optional[str] = None


class SendMessageTool(BaseTool):
    name: str = "send_message"
    description: str = (
        "Send a chat message inside the Finova platform conversation "
        "between accountant and client. Never send emails."
    )
    args_schema: type[SendMessageInput] = SendMessageInput

    def _run(self, content: str, client_ein: Optional[str] = None) -> str:
        base = _pick_backend_base()
        headers = _auth_headers()
        ein = client_ein or os.getenv("CLIENT_EIN")

        if not ein:
            return "No client EIN available."
        if not base:
            return "Backend base URL not configured."
        if "Authorization" not in headers:
            return "No backend JWT available."

        try:
            url = f"{base}/messages/{ein}"
            payload = {
                "content": content,
                "sentVia": "PLATFORM"
            }
            r = requests.post(url, headers=headers, json=payload, timeout=15)
            r.raise_for_status()
            return "Message sent successfully."
        except Exception as e:
            return f"Failed to send message: {str(e)}"


def get_backend_tools() -> List[BaseTool]:
    """Return available backend tools based on env. Empty if missing config."""
    base = _pick_backend_base()
    headers = _auth_headers()
    if not base or "Authorization" not in headers:
        return []
    return [
        CompanyFinancialInfoTool(),
        LedgerQueryTool(),
        UsersSearchTool(),
        QueryTodosTool(),
        QueryClientTasksTool(),
        CreateClientTaskTool(),
        SearchDocumentsTool(),
        SendMessageTool(),
    ]
