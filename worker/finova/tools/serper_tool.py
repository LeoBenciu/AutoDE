from crewai.tools import BaseTool
from typing import Type, Optional
from pydantic import BaseModel, Field
import requests
import os
import json

class SerperSearchInput(BaseModel):
    """Input schema for Serper search tool."""
    query: str = Field(..., description="Search query for Romanian accounting information")

class SerperAccountingResearchTool(BaseTool):
    name: str = "serper_accounting_research"
    description: str = "Search the internet for Romanian accounting standards, chart of accounts updates, and transaction categorization guidance"
    args_schema: Type[BaseModel] = SerperSearchInput

    def _run(self, query: str) -> str:
        """Search for Romanian accounting information using Serper API."""
        api_key = os.getenv('SERPER_API_KEY')

        if not api_key:
            return "Internet research unavailable - no Serper API key configured. Using local Romanian Chart of Accounts knowledge only."

        try:
            enhanced_query = f"Romania accounting {query} plan de conturi OMFP 1802"

            url = "https://google.serper.dev/search"
            headers = {
                'X-API-KEY': api_key,
                'Content-Type': 'application/json'
            }

            payload = {
                'q': enhanced_query,
                'gl': 'ro',
                'hl': 'ro',
                'num': 5
            }

            response = requests.post(url, headers=headers, json=payload, timeout=10)
            response.raise_for_status()

            data = response.json()

            results = []
            if 'organic' in data:
                for result in data['organic'][:3]:
                    results.append(f"Title: {result.get('title', '')}\nSnippet: {result.get('snippet', '')}\nSource: {result.get('link', '')}")

            if results:
                return f"Romanian accounting research results for '{query}':\n\n" + "\n\n---\n\n".join(results)
            else:
                return f"No specific information found for '{query}'. Using standard Romanian Chart of Accounts knowledge."

        except requests.exceptions.RequestException as e:
            return f"Internet research temporarily unavailable (network error). Using local Romanian Chart of Accounts knowledge only."
        except Exception as e:
            return f"Internet research temporarily unavailable (error: {str(e)}). Using local Romanian Chart of Accounts knowledge only."

def get_serper_tool() -> Optional[SerperAccountingResearchTool]:
    """Get Serper tool if API key is available, otherwise return None."""
    api_key = os.getenv('SERPER_API_KEY')
    if api_key:
        return SerperAccountingResearchTool()
    return None