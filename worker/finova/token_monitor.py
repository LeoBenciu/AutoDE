#!/usr/bin/env python3
"""
Token Consumption Monitor for Finova Data Extraction
This script monitors EXACTLY where tokens are being consumed
"""

import os
import sys
import time
import json
import requests
from datetime import datetime
from typing import Dict, Any, Optional
import threading
import queue

class TokenMonitor:
    def __init__(self):
        self.token_usage = {
            'total_tokens': 0,
            'prompt_tokens': 0,
            'completion_tokens': 0,
            'calls_by_function': {},
            'calls_by_phase': {},
            'calls_by_document': {},
            'expensive_calls': [],
            'start_time': None,
            'end_time': None
        }
        self.lock = threading.Lock()
        self.monitoring = False

    def start_monitoring(self):
        """Start token monitoring"""
        self.monitoring = True
        self.token_usage['start_time'] = datetime.now()
        print(f"🔍 TOKEN MONITORING STARTED at {self.token_usage['start_time']}", file=sys.stderr)

    def stop_monitoring(self):
        """Stop token monitoring and generate report"""
        self.monitoring = False
        self.token_usage['end_time'] = datetime.now()
        self.generate_report()

    def log_token_usage(self, function_name: str, phase: str, document_name: str,
                       prompt_tokens: int, completion_tokens: int, total_tokens: int,
                       model: str = "unknown", cost_estimate: float = 0.0):
        """Log token usage for a specific function call"""
        if not self.monitoring:
            return

        with self.lock:
            # Update totals
            self.token_usage['total_tokens'] += total_tokens
            self.token_usage['prompt_tokens'] += prompt_tokens
            self.token_usage['completion_tokens'] += completion_tokens

            # Track by function
            if function_name not in self.token_usage['calls_by_function']:
                self.token_usage['calls_by_function'][function_name] = {
                    'calls': 0, 'total_tokens': 0, 'total_cost': 0.0
                }
            self.token_usage['calls_by_function'][function_name]['calls'] += 1
            self.token_usage['calls_by_function'][function_name]['total_tokens'] += total_tokens
            self.token_usage['calls_by_function'][function_name]['total_cost'] += cost_estimate

            # Track by phase
            if phase not in self.token_usage['calls_by_phase']:
                self.token_usage['calls_by_phase'][phase] = {
                    'calls': 0, 'total_tokens': 0, 'total_cost': 0.0
                }
            self.token_usage['calls_by_phase'][phase]['calls'] += 1
            self.token_usage['calls_by_phase'][phase]['total_tokens'] += total_tokens
            self.token_usage['calls_by_phase'][phase]['total_cost'] += cost_estimate

            # Track by document
            if document_name not in self.token_usage['calls_by_document']:
                self.token_usage['calls_by_document'][document_name] = {
                    'calls': 0, 'total_tokens': 0, 'total_cost': 0.0
                }
            self.token_usage['calls_by_document'][document_name]['calls'] += 1
            self.token_usage['calls_by_document'][document_name]['total_tokens'] += total_tokens
            self.token_usage['calls_by_document'][document_name]['total_cost'] += cost_estimate

            # Track expensive calls (>1000 tokens)
            if total_tokens > 1000:
                self.token_usage['expensive_calls'].append({
                    'timestamp': datetime.now().isoformat(),
                    'function': function_name,
                    'phase': phase,
                    'document': document_name,
                    'model': model,
                    'prompt_tokens': prompt_tokens,
                    'completion_tokens': completion_tokens,
                    'total_tokens': total_tokens,
                    'cost_estimate': cost_estimate
                })

            # Real-time logging
            print(f"💰 TOKEN USAGE: {function_name} | {phase} | {document_name} | {total_tokens} tokens | ${cost_estimate:.4f}", file=sys.stderr)

    def generate_report(self):
        """Generate comprehensive token usage report"""
        print(f"\n{'='*80}", file=sys.stderr)
        print(f"🔍 TOKEN CONSUMPTION ANALYSIS REPORT", file=sys.stderr)
        print(f"{'='*80}", file=sys.stderr)

        duration = (self.token_usage['end_time'] - self.token_usage['start_time']).total_seconds()

        print(f"⏱️  Monitoring Duration: {duration:.2f} seconds", file=sys.stderr)
        print(f"📊 Total Tokens: {self.token_usage['total_tokens']:,}", file=sys.stderr)
        print(f"📝 Prompt Tokens: {self.token_usage['prompt_tokens']:,}", file=sys.stderr)
        print(f"📤 Completion Tokens: {self.token_usage['completion_tokens']:,}", file=sys.stderr)

        # Calculate estimated cost (rough estimates)
        total_cost = 0.0
        for func_data in self.token_usage['calls_by_function'].values():
            total_cost += func_data['total_cost']

        print(f"💵 Estimated Cost: ${total_cost:.4f}", file=sys.stderr)

        # Top functions by token usage
        print(f"\n🔥 TOP FUNCTIONS BY TOKEN USAGE:", file=sys.stderr)
        sorted_functions = sorted(
            self.token_usage['calls_by_function'].items(),
            key=lambda x: x[1]['total_tokens'],
            reverse=True
        )

        for i, (func_name, data) in enumerate(sorted_functions[:10], 1):
            print(f"   {i:2d}. {func_name}: {data['total_tokens']:,} tokens ({data['calls']} calls)", file=sys.stderr)

        # Top phases by token usage
        print(f"\n🎯 TOP PHASES BY TOKEN USAGE:", file=sys.stderr)
        sorted_phases = sorted(
            self.token_usage['calls_by_phase'].items(),
            key=lambda x: x[1]['total_tokens'],
            reverse=True
        )

        for i, (phase, data) in enumerate(sorted_phases[:5], 1):
            print(f"   {i:2d}. {phase}: {data['total_tokens']:,} tokens ({data['calls']} calls)", file=sys.stderr)

        # Top documents by token usage
        print(f"\n📄 TOP DOCUMENTS BY TOKEN USAGE:", file=sys.stderr)
        sorted_docs = sorted(
            self.token_usage['calls_by_document'].items(),
            key=lambda x: x[1]['total_tokens'],
            reverse=True
        )

        for i, (doc_name, data) in enumerate(sorted_docs[:5], 1):
            print(f"   {i:2d}. {doc_name}: {data['total_tokens']:,} tokens ({data['calls']} calls)", file=sys.stderr)

        # Expensive calls
        if self.token_usage['expensive_calls']:
            print(f"\n💸 EXPENSIVE CALLS (>1000 tokens):", file=sys.stderr)
            for call in self.token_usage['expensive_calls'][:10]:
                print(f"   🔥 {call['function']} | {call['phase']} | {call['document']} | {call['total_tokens']:,} tokens | ${call['cost_estimate']:.4f}", file=sys.stderr)

        print(f"{'='*80}", file=sys.stderr)

# Global token monitor instance
token_monitor = TokenMonitor()

def monitor_openai_call(function_name: str, phase: str, document_name: str,
                       response_data: Dict[str, Any], model: str = "gpt-4o"):
    """Monitor OpenAI API call and extract token usage"""
    try:
        # Extract token usage from response
        usage = response_data.get('usage', {})
        prompt_tokens = usage.get('prompt_tokens', 0)
        completion_tokens = usage.get('completion_tokens', 0)
        total_tokens = usage.get('total_tokens', 0)

        # Estimate cost based on model
        cost_per_1k_tokens = {
            'gpt-4o': 0.005,  # $5 per 1M tokens
            'gpt-4o-mini': 0.00015,  # $0.15 per 1M tokens
            'gpt-4': 0.03,  # $30 per 1M tokens
            'gpt-3.5-turbo': 0.0015  # $1.5 per 1M tokens
        }

        cost_per_token = cost_per_1k_tokens.get(model, 0.005) / 1000
        cost_estimate = total_tokens * cost_per_token

        # Log to monitor
        token_monitor.log_token_usage(
            function_name, phase, document_name,
            prompt_tokens, completion_tokens, total_tokens,
            model, cost_estimate
        )

    except Exception as e:
        print(f"⚠️  Error monitoring token usage: {e}", file=sys.stderr)

def start_token_monitoring():
    """Start token monitoring"""
    token_monitor.start_monitoring()

def stop_token_monitoring():
    """Stop token monitoring and generate report"""
    token_monitor.stop_monitoring()

def log_function_call(function_name: str, phase: str, document_name: str,
                    prompt_tokens: int = 0, completion_tokens: int = 0,
                    total_tokens: int = 0, model: str = "unknown"):
    """Log a function call for token monitoring"""
    cost_per_token = 0.005 / 1000  # Default cost estimate
    cost_estimate = total_tokens * cost_per_token

    token_monitor.log_token_usage(
        function_name, phase, document_name,
        prompt_tokens, completion_tokens, total_tokens,
        model, cost_estimate
    )
