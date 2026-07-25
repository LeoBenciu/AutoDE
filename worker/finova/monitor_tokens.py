#!/usr/bin/env python3
"""
Real-time Token Consumption Monitor
This script monitors token usage in real-time to identify the exact culprit
"""

import os
import sys
import time
import json
import threading
import queue
from datetime import datetime
from typing import Dict, Any, Optional

class RealTimeTokenMonitor:
    def __init__(self):
        self.token_usage = {
            'total_tokens': 0,
            'prompt_tokens': 0,
            'completion_tokens': 0,
            'calls': [],
            'start_time': None,
            'current_document': None,
            'current_phase': None
        }
        self.lock = threading.Lock()
        self.monitoring = False

    def start_monitoring(self, document_name: str, phase: str):
        """Start monitoring for a specific document and phase"""
        with self.lock:
            self.monitoring = True
            self.token_usage['start_time'] = datetime.now()
            self.token_usage['current_document'] = document_name
            self.token_usage['current_phase'] = phase
            print(f"🔍 REAL-TIME MONITORING STARTED: {document_name} | {phase}", file=sys.stderr)

    def log_token_usage(self, function_name: str, prompt_tokens: int, completion_tokens: int,
                       total_tokens: int, model: str = "unknown", cost: float = 0.0):
        """Log token usage in real-time"""
        if not self.monitoring:
            return

        with self.lock:
            # Update totals
            self.token_usage['total_tokens'] += total_tokens
            self.token_usage['prompt_tokens'] += prompt_tokens
            self.token_usage['completion_tokens'] += completion_tokens

            # Add to calls list
            call_data = {
                'timestamp': datetime.now().isoformat(),
                'function': function_name,
                'document': self.token_usage['current_document'],
                'phase': self.token_usage['current_phase'],
                'model': model,
                'prompt_tokens': prompt_tokens,
                'completion_tokens': completion_tokens,
                'total_tokens': total_tokens,
                'cost': cost
            }
            self.token_usage['calls'].append(call_data)

            # Real-time logging
            print(f"💰 TOKEN USAGE: {function_name} | {total_tokens:,} tokens | ${cost:.4f}", file=sys.stderr)

            # Alert for expensive calls
            if total_tokens > 5000:
                print(f"🚨 EXPENSIVE CALL: {function_name} used {total_tokens:,} tokens (${cost:.4f})", file=sys.stderr)

    def get_current_stats(self):
        """Get current token usage statistics"""
        with self.lock:
            return {
                'total_tokens': self.token_usage['total_tokens'],
                'prompt_tokens': self.token_usage['prompt_tokens'],
                'completion_tokens': self.token_usage['completion_tokens'],
                'calls_count': len(self.token_usage['calls']),
                'current_document': self.token_usage['current_document'],
                'current_phase': self.token_usage['current_phase']
            }

    def stop_monitoring(self):
        """Stop monitoring and generate report"""
        with self.lock:
            self.monitoring = False
            end_time = datetime.now()
            duration = (end_time - self.token_usage['start_time']).total_seconds()

            print(f"\n🔍 REAL-TIME MONITORING COMPLETED", file=sys.stderr)
            print(f"⏱️  Duration: {duration:.2f} seconds", file=sys.stderr)
            print(f"📊 Total Tokens: {self.token_usage['total_tokens']:,}", file=sys.stderr)
            print(f"📝 Prompt Tokens: {self.token_usage['prompt_tokens']:,}", file=sys.stderr)
            print(f"📤 Completion Tokens: {self.token_usage['completion_tokens']:,}", file=sys.stderr)
            print(f"🔢 Total Calls: {len(self.token_usage['calls'])}", file=sys.stderr)

            # Calculate total cost
            total_cost = sum(call['cost'] for call in self.token_usage['calls'])
            print(f"💵 Total Cost: ${total_cost:.4f}", file=sys.stderr)

            # Show top expensive calls
            expensive_calls = sorted(
                self.token_usage['calls'],
                key=lambda x: x['total_tokens'],
                reverse=True
            )[:5]

            if expensive_calls:
                print(f"\n🔥 TOP 5 EXPENSIVE CALLS:", file=sys.stderr)
                for i, call in enumerate(expensive_calls, 1):
                    print(f"   {i}. {call['function']}: {call['total_tokens']:,} tokens (${call['cost']:.4f})", file=sys.stderr)

# Global real-time monitor
realtime_monitor = RealTimeTokenMonitor()

def start_realtime_monitoring(document_name: str, phase: str):
    """Start real-time token monitoring"""
    realtime_monitor.start_monitoring(document_name, phase)

def log_realtime_token_usage(function_name: str, prompt_tokens: int, completion_tokens: int,
                           total_tokens: int, model: str = "unknown", cost: float = 0.0):
    """Log token usage to real-time monitor"""
    realtime_monitor.log_token_usage(function_name, prompt_tokens, completion_tokens,
                                   total_tokens, model, cost)

def stop_realtime_monitoring():
    """Stop real-time token monitoring"""
    realtime_monitor.stop_monitoring()

def get_current_token_stats():
    """Get current token usage statistics"""
    return realtime_monitor.get_current_stats()

# Monkey patch OpenAI client to monitor token usage
def patch_openai_client():
    """Patch OpenAI client to monitor token usage"""
    try:
        import openai
        from openai import OpenAI

        # Store original methods
        original_chat_completions_create = OpenAI.chat.completions.create

        def monitored_chat_completions_create(self, *args, **kwargs):
            """Monitored version of chat.completions.create"""
            start_time = time.time()

            # Call original method
            response = original_chat_completions_create(self, *args, **kwargs)

            # Extract token usage
            if hasattr(response, 'usage') and response.usage:
                usage = response.usage
                prompt_tokens = getattr(usage, 'prompt_tokens', 0)
                completion_tokens = getattr(usage, 'completion_tokens', 0)
                total_tokens = getattr(usage, 'total_tokens', 0)

                # Estimate cost
                model = kwargs.get('model', 'unknown')
                cost_per_1k = {
                    'gpt-4o': 0.005,
                    'gpt-4o-mini': 0.00015,
                    'gpt-4': 0.03,
                    'gpt-3.5-turbo': 0.0015
                }
                cost_per_token = cost_per_1k.get(model, 0.005) / 1000
                cost = total_tokens * cost_per_token

                # Log to real-time monitor
                log_realtime_token_usage(
                    "openai_chat_completion",
                    prompt_tokens,
                    completion_tokens,
                    total_tokens,
                    model,
                    cost
                )

            return response

        # Replace the method
        OpenAI.chat.completions.create = monitored_chat_completions_create

        print("✅ OpenAI client patched for token monitoring", file=sys.stderr)
        return True

    except Exception as e:
        print(f"⚠️  Failed to patch OpenAI client: {e}", file=sys.stderr)
        return False

if __name__ == "__main__":
    # Test the monitor
    print("🧪 Testing Real-time Token Monitor")

    start_realtime_monitoring("test_document.pdf", "Phase_0")

    # Simulate some token usage
    log_realtime_token_usage("test_function", 1000, 500, 1500, "gpt-4o", 0.0075)
    log_realtime_token_usage("expensive_function", 5000, 2000, 7000, "gpt-4o", 0.035)

    stop_realtime_monitoring()
