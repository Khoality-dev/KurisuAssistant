#!/usr/bin/env python3
"""
Simple test script for the MCP Context Server.
Tests database connection and MCP functions.
"""

from datetime import datetime, timedelta
from db import test_connection
from main import retrieve_messages_by_date_range, retrieve_messages_by_regex, get_conversation_summary

def test_database():
    """Test database connection."""
    print("=== Testing Database Connection ===")
    if test_connection():
        print("✓ Database connection successful")
        return True
    else:
        print("✗ Database connection failed")
        return False

def test_mcp_functions():
    """Test MCP functions with conversation ID 1."""
    print("\n=== Testing MCP Functions ===")
    test_conversation_id = 1
    
    # Test 1: Date range
    print(f"Testing date range retrieval for conversation {test_conversation_id}...")
    try:
        end_date = datetime.now().isoformat()
        start_date = (datetime.now() - timedelta(days=30)).isoformat()
        
        result = retrieve_messages_by_date_range(
            conversation_id=test_conversation_id,
            start_date=start_date,
            end_date=end_date,
            limit=3
        )
        print(f"✓ Result: {result[:100]}...")
    except Exception as e:
        print(f"✗ Date range test failed: {e}")
    
    # Test 2: Regex search
    print(f"\nTesting regex search for conversation {test_conversation_id}...")
    try:
        result = retrieve_messages_by_regex(
            conversation_id=test_conversation_id,
            pattern=".*",
            limit=2
        )
        print(f"✓ Result: {result[:100]}...")
    except Exception as e:
        print(f"✗ Regex test failed: {e}")
    
    # Test 3: Conversation summary
    print(f"\nTesting conversation summary for conversation {test_conversation_id}...")
    try:
        result = get_conversation_summary(conversation_id=test_conversation_id)
        print(f"✓ Result: {result[:100]}...")
    except Exception as e:
        print(f"✗ Summary test failed: {e}")

def main():
    """Run all tests."""
    print("MCP Context Server - Simple Test")
    print("=" * 40)
    
    if not test_database():
        print("\nPlease check DATABASE_URL and ensure PostgreSQL is running.")
        return False
    
    test_mcp_functions()
    
    print("\n" + "=" * 40)
    print("✓ MCP Context Server test completed!")
    return True

if __name__ == "__main__":
    main()