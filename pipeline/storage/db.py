"""
storage/db.py — SQLAlchemy engine + session factory for pipeline databases.

Creates two SQLite databases:
  - Staging DB: stg_* tables, candidate_matches
  - Curated DB: station_master, match_decisions, review_queue, source_refresh_audit

Both use WAL mode for better concurrent read performance.
"""

from __future__ import annotations

from contextlib import contextmanager
from pathlib import Path
from typing import Generator

import structlog
from sqlalchemy import create_engine, event, text
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

from config import CURATED_DB_PATH, CURATED_DB_URL, STAGING_DB_PATH, STAGING_DB_URL

log = structlog.get_logger(__name__)


# ═══════════════════════════════════════════════════════════
# WAL MODE ENABLER
# ═══════════════════════════════════════════════════════════

def _enable_wal(dbapi_connection, connection_record) -> None:
    """Enable WAL journal mode and set pragmas on each new SQLite connection."""
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA synchronous=NORMAL")   # Faster than FULL, still safe with WAL
    cursor.execute("PRAGMA temp_store=MEMORY")     # Temp tables in RAM
    cursor.execute("PRAGMA mmap_size=268435456")   # 256MB memory-mapped I/O
    cursor.execute("PRAGMA cache_size=-64000")     # 64MB page cache
    cursor.close()


# ═══════════════════════════════════════════════════════════
# ENGINE FACTORY
# ═══════════════════════════════════════════════════════════

def get_engine(db_url: str, echo: bool = False) -> Engine:
    """
    Create a SQLAlchemy Engine for a SQLite database with WAL mode.

    Args:
        db_url: SQLAlchemy connection URL (sqlite:///path/to/file.db)
        echo: If True, log all SQL statements (useful for debugging)

    Returns:
        SQLAlchemy Engine with WAL mode enabled.
    """
    engine = create_engine(
        db_url,
        echo=echo,
        connect_args={
            "check_same_thread": False,  # Allow use from multiple threads
            "timeout": 30,               # Wait up to 30s for lock release
        },
    )
    event.listen(engine, "connect", _enable_wal)
    log.info("db_engine_created", url=db_url.replace(str(Path(db_url.split("///")[1]).parent), "..."))
    return engine


# ═══════════════════════════════════════════════════════════
# SINGLETON ENGINES (created once, reused)
# ═══════════════════════════════════════════════════════════

_staging_engine: Engine | None = None
_curated_engine: Engine | None = None


def get_staging_engine(echo: bool = False) -> Engine:
    """Get (or create) the staging database engine."""
    global _staging_engine
    if _staging_engine is None:
        _staging_engine = get_engine(STAGING_DB_URL, echo=echo)
    return _staging_engine


def get_curated_engine(echo: bool = False) -> Engine:
    """Get (or create) the curated database engine."""
    global _curated_engine
    if _curated_engine is None:
        _curated_engine = get_engine(CURATED_DB_URL, echo=echo)
    return _curated_engine


# ═══════════════════════════════════════════════════════════
# SESSION FACTORIES
# ═══════════════════════════════════════════════════════════

def _make_session_factory(engine: Engine) -> sessionmaker:
    return sessionmaker(bind=engine, autoflush=True, autocommit=False)


def get_staging_session() -> Session:
    """Get a new Session for the staging database."""
    return _make_session_factory(get_staging_engine())()


def get_curated_session() -> Session:
    """Get a new Session for the curated database."""
    return _make_session_factory(get_curated_engine())()


@contextmanager
def staging_session() -> Generator[Session, None, None]:
    """Context manager for staging database sessions."""
    session = get_staging_session()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


@contextmanager
def curated_session() -> Generator[Session, None, None]:
    """Context manager for curated database sessions."""
    session = get_curated_session()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()


# ═══════════════════════════════════════════════════════════
# DATABASE INITIALIZATION
# ═══════════════════════════════════════════════════════════

def init_db() -> None:
    """
    Initialize both staging and curated databases.
    Creates all tables if they don't exist.
    Safe to call multiple times (idempotent).
    """
    from storage.schema import Base, StagingBase

    staging_engine = get_staging_engine()
    curated_engine = get_curated_engine()

    log.info("db_init_start")

    StagingBase.metadata.create_all(staging_engine)
    log.info("staging_db_initialized", path=str(STAGING_DB_PATH))

    Base.metadata.create_all(curated_engine)
    log.info("curated_db_initialized", path=str(CURATED_DB_PATH))


def verify_db_health() -> dict[str, bool]:
    """
    Quick health check for both databases.
    Returns dict of {db_name: is_healthy}.
    """
    results: dict[str, bool] = {}

    for name, engine in [("staging", get_staging_engine()), ("curated", get_curated_engine())]:
        try:
            with engine.connect() as conn:
                conn.execute(text("SELECT 1"))
            results[name] = True
        except Exception as e:
            log.error("db_health_check_failed", db=name, error=str(e))
            results[name] = False

    return results
