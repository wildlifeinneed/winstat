"""Tests for is_available() day-of-week patterns."""
import sys
import os
from datetime import date

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from refresh_monday import is_available

# Fixtures
MONDAY    = date(2026, 6,  8)  # weekday() == 0
SATURDAY  = date(2026, 6, 13)  # weekday() == 5


# --- 'Unavail weekends' ---
def test_unavail_weekends_on_weekday():
    assert is_available("Unavail weekends", today=MONDAY) is True

def test_unavail_weekends_on_weekend():
    assert is_available("Unavail weekends", today=SATURDAY) is False


# --- 'Avail weekends' ---
def test_avail_weekends_on_weekday():
    assert is_available("Avail weekends", today=MONDAY) is False

def test_avail_weekends_on_weekend():
    assert is_available("Avail weekends", today=SATURDAY) is True


# --- 'Avail weekdays' ---
def test_avail_weekdays_on_weekday():
    assert is_available("Avail weekdays", today=MONDAY) is True

def test_avail_weekdays_on_weekend():
    assert is_available("Avail weekdays", today=SATURDAY) is False


# --- Existing behaviour preserved ---
def test_blank_is_available():
    assert is_available("", today=MONDAY) is True

def test_unavail_until_further_notice():
    assert is_available("Unavail until further notice", today=MONDAY) is False

def test_unavail_date_range_outside():
    # 6/1-6/5 range; MONDAY is 6/8 — should be available
    assert is_available("Unavail 6/1-6/5", today=MONDAY) is True

def test_unavail_date_range_inside():
    # SATURDAY is 6/13 — inside 6/10-6/20 range
    assert is_available("Unavail 6/10-6/20", today=SATURDAY) is False


# --- 'Avail Weekdays, Weekends' (both → always available) ---
def test_avail_weekdays_weekends_on_weekday():
    assert is_available("Avail Weekdays, Weekends", today=MONDAY) is True

def test_avail_weekdays_weekends_on_weekend():
    assert is_available("Avail Weekdays, Weekends", today=SATURDAY) is True

def test_avail_weekdays_and_weekends_on_weekday():
    assert is_available("Avail Weekdays and Weekends", today=MONDAY) is True

def test_avail_weekdays_and_weekends_on_weekend():
    assert is_available("Avail Weekdays and Weekends", today=SATURDAY) is True


# --- 'Unavail Weekdays, Weekends' (both → always unavailable) ---
def test_unavail_weekdays_weekends_on_weekday():
    assert is_available("Unavail Weekdays, Weekends", today=MONDAY) is False

def test_unavail_weekdays_weekends_on_weekend():
    assert is_available("Unavail Weekdays, Weekends", today=SATURDAY) is False
