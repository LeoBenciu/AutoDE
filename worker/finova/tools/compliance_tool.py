from crewai.tools import BaseTool
from typing import Type, Optional
from pydantic import BaseModel, Field
import requests
import os
import json

class ComplianceSearchInput(BaseModel):
    """Input schema for compliance search tool."""
    query: str = Field(..., description="Search query for Romanian tax compliance deadlines, e.g., 'VAT return deadline 2025', 'payroll tax deadline Romania'")
    company_type: Optional[str] = Field(None, description="Company type or VAT payment frequency (MONTHLY, QUARTERLY, NONE)")

class ComplianceResearchTool(BaseTool):
    name: str = "compliance_research"
    description: str = (
        "Search the internet for current Romanian tax compliance deadlines, "
        "VAT filing dates, payroll tax deadlines, and other regulatory requirements. "
        "Use this to find the most up-to-date compliance information from official sources."
    )
    args_schema: Type[BaseModel] = ComplianceSearchInput

    def _run(self, query: str, company_type: Optional[str] = None) -> str:
        """Search for Romanian compliance deadlines using Serper API."""
        import sys
        print(f"[COMPLIANCE TOOL] Starting search for: {query}", file=sys.stderr)
        api_key = os.getenv('SERPER_API_KEY')

        if not api_key:
            print("[COMPLIANCE TOOL] ERROR: SERPER_API_KEY not configured", file=sys.stderr)
            return "Internet research unavailable - no Serper API key configured."

        try:
            # Enhance query for Romanian compliance
            enhanced_query = f"Romania {query} termen limita ANAF 2025"
            if company_type:
                enhanced_query += f" {company_type}"

            print(f"[COMPLIANCE TOOL] Enhanced query: {enhanced_query}", file=sys.stderr)

            url = "https://google.serper.dev/search"
            headers = {
                'X-API-KEY': api_key,
                'Content-Type': 'application/json'
            }

            payload = {
                'q': enhanced_query,
                'gl': 'ro',  # Romania
                'hl': 'ro',  # Romanian language
                'num': 5,
                'type': 'search'
            }

            print(f"[COMPLIANCE TOOL] Sending request to Serper API...", file=sys.stderr)
            response = requests.post(url, headers=headers, json=payload, timeout=15)
            response.raise_for_status()

            data = response.json()
            print(f"[COMPLIANCE TOOL] Received response from Serper API", file=sys.stderr)

            results = []
            if 'organic' in data:
                print(f"[COMPLIANCE TOOL] Found {len(data['organic'])} organic results", file=sys.stderr)
                for result in data['organic'][:5]:
                    results.append({
                        'title': result.get('title', ''),
                        'snippet': result.get('snippet', ''),
                        'source': result.get('link', '')
                    })

            # Also check for answer box (direct answers)
            answer_box = data.get('answerBox', {})
            if answer_box:
                print("[COMPLIANCE TOOL] Found answer box in response", file=sys.stderr)
                results.insert(0, {
                    'title': answer_box.get('title', ''),
                    'snippet': answer_box.get('answer', '') or answer_box.get('snippet', ''),
                    'source': answer_box.get('link', ''),
                    'is_answer_box': True
                })

            if results:
                print(f"[COMPLIANCE TOOL] Returning {len(results)} results", file=sys.stderr)
                formatted_results = []
                for i, result in enumerate(results, 1):
                    formatted_results.append(
                        f"{i}. {result['title']}\n"
                        f"   {result['snippet']}\n"
                        f"   Source: {result['source']}"
                    )
                return f"Compliance research results for '{query}':\n\n" + "\n\n".join(formatted_results)
            else:
                print("[COMPLIANCE TOOL] No results found", file=sys.stderr)
                return f"No specific information found for '{query}'. Please check official ANAF website."

        except requests.exceptions.RequestException as e:
            print(f"[COMPLIANCE TOOL] Request error: {str(e)}", file=sys.stderr)
            return f"Error searching for compliance information: {str(e)}"
        except Exception as e:
            print(f"[COMPLIANCE TOOL] Unexpected error: {str(e)}", file=sys.stderr)
            import traceback
            traceback.print_exc(file=sys.stderr)
            return f"Unexpected error: {str(e)}"

def get_compliance_tool() -> Optional[ComplianceResearchTool]:
    """Get compliance tool if API key is available, otherwise return None."""
    api_key = os.getenv('SERPER_API_KEY')
    if api_key:
        return ComplianceResearchTool()
    return None
