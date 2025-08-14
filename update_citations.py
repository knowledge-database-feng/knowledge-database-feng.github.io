#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import os
import json
import time
import argparse
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple
from tqdm import tqdm
from concurrent.futures import ThreadPoolExecutor, as_completed
import threading
from datetime import datetime, timedelta

WINDOW_PREFIX = "window.dataset ="
WINDOW_SUFFIX_SEMICOLON = ";"

@dataclass
class Config:
    serpapi_key: Optional[str]
    engine: str  # "serpapi" or "scholarly"
    delay_sec: float
    max_retries: int
    backoff: float
    only_missing: bool
    dry_run: bool
    workers: int
    force_update: bool  # Force update regardless of last update date

def load_dataset(path: str) -> Dict[str, Any]:
    """Load dataset from JSON or JS (window.dataset = {...};)."""
    with open(path, "r", encoding="utf-8") as f:
        txt = f.read()
    if txt.strip().startswith(WINDOW_PREFIX):
        js_payload = txt.strip()
        js_payload = js_payload[len(WINDOW_PREFIX):].strip()
        if js_payload.endswith(WINDOW_SUFFIX_SEMICOLON):
            js_payload = js_payload[:-1].strip()
        if js_payload.endswith(WINDOW_SUFFIX_SEMICOLON):
            js_payload = js_payload[:-1].strip()
        data = json.loads(js_payload)
        return data
    return json.loads(txt)

def write_dataset_json(path: str, data: Dict[str, Any]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")

def write_dataset_js(path: str, data: Dict[str, Any]) -> None:
    with open(path, "w", encoding="utf-8") as f:
        f.write(f"{WINDOW_PREFIX} ")
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write(f"{WINDOW_SUFFIX_SEMICOLON}\n")

def scholar_link_from_id(scholarid: str) -> str:
    return f"https://scholar.google.com/citations?user={scholarid}"

def safe_int(x: Any) -> Optional[int]:
    try:
        if x is None:
            return None
        return int(x)
    except Exception:
        try:
            return int(str(x).replace(",", ""))
        except Exception:
            return None

def fetch_citations_serpapi(scholarid: str, serpapi_key: str) -> Optional[int]:
    """Use SerpAPI's Google Scholar Author endpoint."""
    try:
        import requests  # type: ignore
    except Exception:
        raise RuntimeError("The 'requests' package is required for SerpAPI mode. Install with: pip install requests")

    url = "https://serpapi.com/search.json"
    params = {
        "engine": "google_scholar_author",
        "author_id": scholarid,
        "api_key": serpapi_key,
        "hl": "en",
    }
    r = requests.get(url, params=params, timeout=30)
    r.raise_for_status()
    data = r.json()
    total = None
    try:
        cited_by = data.get("cited_by", {})
        table = cited_by.get("table", [])
        if table and isinstance(table, list):
            first = table[0]
            citations = first.get("citations", {})
            total = citations.get("all")
    except Exception:
        total = None
    if total is None:
        try:
            total = data.get("cited_by", {}).get("graph", {}).get("total", None)
        except Exception:
            total = None
    return safe_int(total)

def fetch_citations_scholarly(scholarid: str) -> Optional[int]:
    """Use scholarly (no API key, slower and may be rate-limited)."""
    try:
        from scholarly import scholarly  # type: ignore
    except Exception:
        raise RuntimeError("The 'scholarly' package is required for scholarly mode. Install with: pip install scholarly")
    try:
        author = scholarly.search_author_id(scholarid)
        author = scholarly.fill(author, sections=["indices"])
        return safe_int(author.get("citedby"))
    except Exception:
        return None

def fetch_citations(scholarid: str, cfg: Config) -> Optional[int]:
    if not scholarid or scholarid == "NOSCHOLARPAGE":
        return None
    for attempt in range(1, cfg.max_retries + 1):
        try:
            if cfg.engine == "serpapi":
                if not cfg.serpapi_key:
                    raise RuntimeError("SERPAPI_KEY not provided; cannot use serpapi engine.")
                val = fetch_citations_serpapi(scholarid, cfg.serpapi_key)
            else:
                val = fetch_citations_scholarly(scholarid)
            if val is not None:
                return val
        except Exception as e:
            print(f"[warn] attempt {attempt} for {scholarid} failed: {e}")
        sleep_for = cfg.delay_sec * (cfg.backoff ** (attempt - 1))
        time.sleep(sleep_for)
    return None

def summarize_total(nodes: List[Dict[str, Any]]) -> int:
    total = 0
    for n in nodes:
        ci = safe_int(n.get("citations"))
        if ci is not None:
            total += ci
    return total

def should_update_node(node: Dict[str, Any], cfg: Config) -> Tuple[bool, str]:
    """Check if a node should be updated based on last update date."""
    if cfg.force_update:
        return True, "Force update enabled"
    
    last_update = node.get("last_citation_update")
    if not last_update:
        return True, "No previous update date"
    
    try:
        last_update_date = datetime.fromisoformat(last_update.replace('Z', '+00:00'))
        six_months_ago = datetime.now(last_update_date.tzinfo) - timedelta(days=180)
        
        if last_update_date < six_months_ago:
            return True, f"Last update {last_update_date.date()} is older than 6 months"
        else:
            return False, f"Last update {last_update_date.date()} is recent (within 6 months)"
    except Exception as e:
        return True, f"Invalid date format: {e}"

def process_single_node(node: Dict[str, Any], cfg: Config) -> Tuple[str, Optional[int], bool, str]:
    """Process a single node and return (name, citations, success, message)."""
    scholarid = node.get("scholarid") or node.get("scholarId") or node.get("scholar_id")
    name = node.get("name", "<unknown>")
    
    if not scholarid:
        return name, None, False, "No scholar ID"
    
    if scholarid == "NOSCHOLARPAGE":
        node.setdefault("scholarLink", None)
        return name, None, False, "No scholar page"
    
    # Check if we should update based on last update date
    should_update, reason = should_update_node(node, cfg)
    if not should_update:
        node["scholarLink"] = scholar_link_from_id(scholarid)
        return name, None, False, f"Skipped: {reason}"
    
    if cfg.only_missing and safe_int(node.get("citations")) is not None:
        node["scholarLink"] = scholar_link_from_id(scholarid)
        return name, None, False, "Already has citations"
    
    if cfg.dry_run:
        return name, None, False, "Dry run"
    
    val = fetch_citations(scholarid, cfg)
    if val is not None:
        node["citations"] = val
        node["scholarLink"] = scholar_link_from_id(scholarid)
        # Add current timestamp as last update date
        node["last_citation_update"] = datetime.now().isoformat()
        return name, val, True, f"Updated: {val}"
    else:
        return name, None, False, "Failed to fetch citations"

def update_nodes(nodes: List[Dict[str, Any]], cfg: Config) -> Tuple[int, int, List[Dict[str, Any]]]:
    updated = 0
    skipped = 0
    failed_citations: List[Dict[str, Any]] = []
    
    # Filter nodes that need processing
    nodes_to_process = []
    for node in nodes:
        scholarid = node.get("scholarid") or node.get("scholarId") or node.get("scholar_id")
        if not scholarid or scholarid == "NOSCHOLARPAGE":
            skipped += 1
            continue
        if cfg.only_missing and safe_int(node.get("citations")) is not None:
            node["scholarLink"] = scholar_link_from_id(scholarid)
            skipped += 1
            continue
        if cfg.dry_run:
            print(f"[dry-run] Would update {node.get('name','<unknown>')} ({scholarid})")
            skipped += 1
            continue
        nodes_to_process.append(node)
    
    if not nodes_to_process:
        return updated, skipped, failed_citations
    
    # Process nodes in parallel
    with ThreadPoolExecutor(max_workers=cfg.workers) as executor:
        # Submit all tasks
        future_to_node = {
            executor.submit(process_single_node, node, cfg): node 
            for node in nodes_to_process
        }
        
        # Process completed tasks
        with tqdm(total=len(nodes_to_process), desc="Updating citations") as pbar:
            for future in as_completed(future_to_node):
                node = future_to_node[future]
                try:
                    name, citations, success, message = future.result()
                    if success:
                        updated += 1
                        print(f"[ok] {name}: {citations}")
                    else:
                        if "Failed to fetch citations" in message:
                            failed_citations.append(node)
                        skipped += 1
                except Exception as e:
                    name = node.get("name", "<unknown>")
                    print(f"[error] {name}: {e}")
                    failed_citations.append(node)
                    skipped += 1
                pbar.update(1)
                
                # Add delay between completions to respect rate limits
                time.sleep(cfg.delay_sec / cfg.workers)
    
    return updated, skipped, failed_citations

def main():
    parser = argparse.ArgumentParser(description="Update Google Scholar total citations into dataset files.")
    parser.add_argument("--input", default="dataset.json", help="Input dataset file (dataset.json or dataset.js)")
    parser.add_argument("--output-json", default="dataset.json", help="Output JSON file to write")
    parser.add_argument("--output-js", default="dataset.js", help="Output JS file to write")
    parser.add_argument("--engine", choices=["serpapi", "scholarly"], default=None,
                        help="Fetch engine. Default: 'serpapi' if SERPAPI_KEY is set, else 'scholarly'.")
    parser.add_argument("--delay", type=float, default=2.0, help="Base delay (seconds) between requests (default: 2.0)")
    parser.add_argument("--max-retries", type=int, default=2, help="Max retries per author (default: 2)")
    parser.add_argument("--backoff", type=float, default=1.5, help="Exponential backoff factor (default: 1.5)")
    parser.add_argument("--workers", type=int, default=8, help="Number of parallel workers (default: 8)")
    parser.add_argument("--only-missing", action="store_true", help="Only fetch for nodes missing 'citations'")
    parser.add_argument("--force-update", action="store_true", help="Force update all nodes regardless of last update date")
    parser.add_argument("--dry-run", action="store_true", help="Show what would change without writing files")
    parser.add_argument("--no-write-js", action="store_true", help="Do not write dataset.js")
    parser.add_argument("--no-write-json", action="store_true", help="Do not write dataset.json")
    args = parser.parse_args()

    serpapi_key = os.getenv("SERPAPI_KEY")
    engine = args.engine or ("serpapi" if serpapi_key else "scholarly")

    cfg = Config(
        serpapi_key=serpapi_key,
        engine=engine,
        delay_sec=max(0.5, float(args.delay)),
        max_retries=max(1, int(args.max_retries)),
        backoff=max(1.0, float(args.backoff)),
        only_missing=bool(args.only_missing),
        dry_run=bool(args.dry_run),
        workers=max(1, int(args.workers)),
        force_update=bool(args.force_update),
    )

    print(f"[cfg] engine={cfg.engine} delay={cfg.delay_sec}s retries={cfg.max_retries} backoff={cfg.backoff} workers={cfg.workers} only_missing={cfg.only_missing} force_update={cfg.force_update}")

    data = load_dataset(args.input)
    nodes = data.get("nodes", [])
    if not isinstance(nodes, list):
        raise ValueError("Dataset must contain a 'nodes' list.")

    updated, skipped, failed_citations = update_nodes(nodes, cfg)
    total = summarize_total(nodes)
    print(f"\n[summary] updated={updated}, skipped={skipped}, failed={len(failed_citations)}, total_citations={total:,}")

    if not cfg.dry_run:
        if not args.no_write_json:
            write_dataset_json(args.output_json, data)
            print(f"[write] Wrote {args.output_json}")
        if not args.no_write_js:
            write_dataset_js(args.output_js, data)
            print(f"[write] Wrote {args.output_js}")
        with open("total_citations.txt", "w", encoding="utf-8") as f:
            f.write(str(total) + "\n")
        print("[write] Wrote total_citations.txt")

    if failed_citations:
        print(f"\n[failed] Failed to fetch citations for {len(failed_citations)} nodes:")
        with open("failed_citations.txt", "w", encoding="utf-8") as f:
            for item in tqdm(failed_citations, desc="Writing failed citations", leave=False):
                f.write(json.dumps(item, ensure_ascii=False) + "\n")
        print("[write] Wrote failed_citations.txt")

if __name__ == "__main__":
    main()
