#!/usr/bin/env python
# PYTHON_ARGCOMPLETE_OK

"""KiPLM management tool."""

import asyncio
import argparse
import contextlib
import logging
import inspect
import json
import re
import sqlite3
import sys
import traceback

from argparse import Namespace, ArgumentParser
from pathlib import Path
from typing import Generator

from aiohttp import web
import argcomplete
import asyncinotify
from colorama import Fore, Style
import pandas


ROOT_DIR       = Path(__file__).parent
FRONTEND_DIR   = ROOT_DIR / 'frontend'
DB_DIR         = ROOT_DIR / 'db'
SQLITE_FILE    = ROOT_DIR / 'kicad_libs/parts.sqlite'
KICAD_DBL_FILE = ROOT_DIR / 'kicad_libs/KiPLM.kicad_dbl'
MONKEY_API_URI = '/monkey-api/'

api_routes = web.RouteTableDef()


def main() -> None:
    """Main entry point."""
    
    # Create the command line parser
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(metavar='command', dest='command', required=True)

    # Add all run_cmd_... functions as commands
    cmd_generators = {}
    for fn_name, fn in inspect.getmembers(sys.modules[__name__], inspect.isfunction):
        if fn_name.startswith('run_cmd_'):
            cmd_name = fn_name.partition('run_cmd_')[2]
            fn_brief = fn.__doc__.partition('\n\n')[0].strip()
            sp = subparsers.add_parser(cmd_name, help=fn_brief)
            gen = fn(sp)
            next(gen)
            cmd_generators[cmd_name] = gen
            
    # Parse the command line
    argcomplete.autocomplete(parser)
    cmd_line_args = parser.parse_args()
    
    # Set up logging
    logging.basicConfig(level=logging.INFO)
    
    # Run the run_cmd_... for the command given on the command line
    with contextlib.suppress(StopIteration):
        try:
            gen = cmd_generators[cmd_line_args.command]
            gen.send(cmd_line_args)
        except KeyboardInterrupt:
            print('\nSIGINT received, exiting...')
        
        
def run_cmd_build(sp: ArgumentParser) -> Generator[None, Namespace, None]:
    """Creates/updates the SQLite database and the .kicad_dbl file."""
    
    # Add and parse the command line arguments
    sp.add_argument('-w', '--watch', action='store_true',
                    help='automatically rebuild the database when a CSV file changes')
    
    cmd_line_args = yield
    
    # Build the KiCad database library
    build_kicad_lib()
    
    # Watch the CSV files for changes and update the library
    if cmd_line_args.watch:
        asyncio.run(watch_csv_files_and_build_kicad_lib())


def run_cmd_dev(sp: ArgumentParser) -> Generator[None, Namespace, None]:
    """Runs the API server and watches the CSV files for rebuilding the KiCad database library."""
    
    # Add and parse the command line arguments
    sp.add_argument('-p', '--port', type=int, default=5000,
                    help='port for the API server to listen on')
    
    sp.add_argument('-a', '--address', default='localhost',
                    help='address for the API server to listen on')
    
    cmd_line_args = yield
    
    # Build the KiCad database library
    build_kicad_lib()
    
    # Simultaneously watch the CSV files for changes and run the API server
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    
    loop.create_task(watch_csv_files_and_build_kicad_lib())
    loop.create_task(run_api_server(cmd_line_args.address, cmd_line_args.port))
    
    loop.run_forever()
    
    
@api_routes.get(MONKEY_API_URI + 'injected_code.js')
async def monkey_api_get_injected_code(request: web.Request) -> web.Response:
    api_url = f'{request.scheme}://{request.host}{request.path}'.rpartition('/')[0] + '/'
    
    table_fields = {}
    all_ipns = []
    for csv_file in sorted(DB_DIR.glob('*.csv')):
        df = pandas.read_csv(csv_file, dtype=str, keep_default_na=False)
        table_fields[csv_file.stem] = list(df.columns)
        all_ipns.extend(df['IPN'].tolist())
    
    content = (FRONTEND_DIR / 'injected_code.js').read_text()
    content = content.replace('/***API_URI***/', api_url)
    content = content.replace('/***STYLE***/', (FRONTEND_DIR / 'injected_style.css').read_text().replace('\n', '\\n'))
    content = content.replace('/***TABLE_FIELDS***/', str(table_fields)[1:-1])
    content = content.replace('/***ALL_IPNS***/', str(all_ipns)[1:-1])
    
    return web.Response(text=content, content_type='application/javascript')


@api_routes.get(MONKEY_API_URI + 'parts')
async def monkey_api_get_parts(request: web.Request) -> web.Response:
    """Endpoint for getting the IPNs for all parts in the database."""
    
    ipns = []
    for csv_file in DB_DIR.glob('*.csv'):
        df = pandas.read_csv(csv_file, dtype=str, keep_default_na=False)
        ipns.extend(df['IPN'].tolist())
    
    return web.json_response(ipns)


@api_routes.get(MONKEY_API_URI + 'part-by-mpn/{mpn}')
async def monkey_api_get_part_by_mpn(request: web.Request) -> web.Response:
    """Endpoint for getting part information for a part identified by its manufacturer product number."""
    mpn = request.match_info.get('mpn')
    
    for csv_file in DB_DIR.glob('*.csv'):
        df = pandas.read_csv(csv_file, dtype=str, keep_default_na=False)
        if 'MPN' in df.columns:
            df = df[df['MPN'] == mpn]
            if not df.empty:
                return web.json_response(df.to_dict(orient='records')[0])
    
    return web.Response(status=404, reason=f'No parts found with MPN: {mpn}')


@api_routes.post(MONKEY_API_URI + 'part/{ipn}')
async def monkey_api_post_part(request: web.Request) -> web.Response:
    """Endpoint for adding a new part to the database."""
    
    # Check that the IPN is valid
    ipn = request.match_info.get('ipn')
    if not re.match(r'^[A-Z]{3}-[0-9]{4}-[a-zA-Z0-9]{4}$', ipn):
        return web.Response(status=400, reason=f'Invalid IPN: {ipn}')
    
    # Check that the CSV file exists
    table_name = ipn[:3]
    csv_file = DB_DIR / f'{table_name}.csv'
    if not csv_file.exists():
        return web.Response(status=404, reason=f'Database table not found: {table_name}')
    
    # Read the CSV file and check that the IPN is not already used
    df = pandas.read_csv(csv_file, dtype=str, keep_default_na=False)
    if ipn in df['IPN'].tolist():
        return web.Response(status=409, reason=f'IPN already exists: {ipn}')
    
    # Get the JSON data from the request
    data = await request.json()
    
    # Update the CSV file
    row = [data.get(field_name) or '' for field_name in df.columns]
    row[0] = ipn
    df.loc[len(df)] = row
    df.to_csv(csv_file, index=False)
    
    return web.json_response(dict(zip(df.columns, row)))
    
    
@api_routes.put(MONKEY_API_URI + 'part/{ipn}')
async def monkey_api_put_part(request: web.Request) -> web.Response:
    """Endpoint for updating some fields of a part."""
    
    # Find the CSV file corresponding to the IPN
    ipn = request.match_info.get('ipn')
    table_name = ipn[:3]
    csv_file = DB_DIR / f'{table_name}.csv'
    if not csv_file.exists():
        return web.Response(status=404, reason=f'Invalid or unknown IPN: {ipn}')
    
    # Read the CSV file and check that the IPN exists
    df = pandas.read_csv(csv_file, dtype=str, keep_default_na=False)
    if ipn not in df['IPN'].tolist():
        return web.Response(status=404, reason=f'Invalid or unknown IPN: {ipn}')
    
    # Get the JSON data from the request
    data = await request.json()
    
    # Update the CSV file
    row = df[df['IPN'] == ipn].iloc[0].tolist()
    for field_name, field_value in data.items():
        if field_name in df.columns:
            row[df.columns.get_loc(field_name)] = field_value
            
    df.loc[df['IPN'] == ipn] = row
    df.to_csv(csv_file, index=False)
    
    return web.json_response(dict(zip(df.columns, row)))
    
    
@contextlib.contextmanager
def ok_fail(desc: str):
    print(f'{desc}... ', end='', flush=True)
    try:
        yield
    except Exception as e:
        print(Fore.RED + 'FAIL')
        traceback.print_exc()
        sys.exit(1)
    else:
        print(Fore.GREEN + 'OK')
    finally:
        print(Style.RESET_ALL, end='', flush=True)


async def watch_csv_files_and_build_kicad_lib() -> None:
    """Watch the CSV files in the DB_DIR directory for changes and rebuild the KiCad library."""
    
    with asyncinotify.Inotify() as inot:
        print('Watching CSV files for changes...')
        inot.add_watch(DB_DIR, asyncinotify.Mask.CLOSE_WRITE | asyncinotify.Mask.DELETE)
        async for event in inot:
            build_kicad_lib([DB_DIR / event.path])
        

def build_kicad_lib(csv_files_for_update: list[Path] | None = None) -> None:
    """Create the KiCad library from the CSV files in the DB_DIR directory.
    
    Args:
        csv_files_for_update: List of CSV files in DB_DIR to use for the update; if None, all CSV files are used.
    """
    
    # Read all CSV files
    csv_files = sorted(DB_DIR.glob('*.csv'))
    csv_dfs = {file.stem: pandas.read_csv(file, dtype=str, keep_default_na=False) for file in csv_files}
    
    # Create or update the SQLite database
    with sqlite3.connect(SQLITE_FILE) as db:
        
        # Delete all tables that do not have an associated CSV file
        cur = db.execute("SELECT name FROM sqlite_master WHERE type='table'")
        for table_name, in cur.fetchall():
            if table_name not in csv_dfs:
                with ok_fail(f'Deleting table {table_name} in {SQLITE_FILE.name}'):
                    db.execute(f'DROP TABLE {table_name}')
        
        # Re-create the tables from the given CSV files
        for csv_file, (table_name, csv_df) in zip(csv_files, csv_dfs.items()):
            if csv_files_for_update is None or csv_file in csv_files_for_update:
                with ok_fail(f'Updating table {table_name} in {SQLITE_FILE.name}'):
                    db.execute(f'DROP TABLE IF EXISTS {table_name}')
                    csv_df.to_sql(table_name, db, index=False)
                
    # Create or update the .kicad_dbl file
    with ok_fail(f'Updating {KICAD_DBL_FILE.name}'):
        sqlite_file_rel = SQLITE_FILE.relative_to(KICAD_DBL_FILE.parent, walk_up=True)
        dbl_data = {
            'meta': {
                'version': 0,
            },
            'name': 'KiPLM components database',
            'description': 'KiPLM components database',
            'source': {
                'type': 'odbc',
                'dsn': '',
                'username': '',
                'password': '',
                'timeout_seconds': 2,
                'connection_string': 'DRIVER={SQLite3};DATABASE=${CWD}/' + str(sqlite_file_rel)
            },
            'libraries': [{
                'name': table_name,
                'table': table_name,
                'key': 'IPN',
                'symbols': 'Symbol',
                'footprints': 'Footprint',
                'fields': [{
                    'column': col_title,
                    'name': col_title,
                    'visible_on_add': False,
                    'visible_in_chooser': True,
                    'show_name': False,
                } for col_title in csv_df.columns]
            } for table_name, csv_df in csv_dfs.items()]
        }

        with open(KICAD_DBL_FILE, 'w') as fh:
            json.dump(dbl_data, fh, indent=2)
            fh.write('\n')
    

async def run_api_server(address: str, port: int) -> None:
    """Run the API server.
    
    Args:
        address: Address for the API server to listen on.
        port:    Port for the API server to listen on.
    """
    
    with ok_fail(f'Starting API server on {address}:{port}'):
        app = web.Application()
        app.add_routes(api_routes)
        
        runner = web.AppRunner(app)
        await runner.setup()
        
        site = web.TCPSite(runner, address, port)
        await site.start()
        
    await asyncio.Event().wait()


# Call the main() function when executed as a script
if __name__ == '__main__':
    main()
