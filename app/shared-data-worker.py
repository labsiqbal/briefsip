import base64
import json
import resource
import sqlite3
import sys
import time

resource.setrlimit(resource.RLIMIT_AS, (256 * 1024 * 1024, 256 * 1024 * 1024))
resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
resource.setrlimit(resource.RLIMIT_FSIZE, (0, 0))
request = json.loads(sys.stdin.buffer.read(24 * 1024 * 1024))
def identifier(name):
    # SQLite NOCASE folds ASCII only, unlike Python str.lower().
    return name.translate(str.maketrans('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz'))


db = sqlite3.connect(':memory:', isolation_level=None)
if request.get('image'):
    db.deserialize(base64.b64decode(request['image'], validate=True))
db.execute('PRAGMA trusted_schema=OFF')
db.execute('PRAGMA temp_store=MEMORY')
db.execute('PRAGMA foreign_keys=ON')
db.execute('PRAGMA max_page_count=4096')
db.execute('CREATE TABLE IF NOT EXISTS briefsip_owners(name TEXT PRIMARY KEY COLLATE NOCASE, owner TEXT NOT NULL)')
for category, limit in [(sqlite3.SQLITE_LIMIT_LENGTH, 1024 * 1024), (sqlite3.SQLITE_LIMIT_SQL_LENGTH, 32000), (sqlite3.SQLITE_LIMIT_COLUMN, 100), (sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, 100), (sqlite3.SQLITE_LIMIT_ATTACHED, 0), (sqlite3.SQLITE_LIMIT_EXPR_DEPTH, 100)]:
    db.setlimit(category, limit)
deadline = time.monotonic() + 1.5
db.set_progress_handler(lambda: time.monotonic() > deadline, 1000)
owner = request.get('owner')
owners = dict(db.execute('SELECT lower(name),owner FROM briefsip_owners'))
indexes = dict(db.execute("SELECT lower(name),tbl_name FROM sqlite_schema WHERE type='index'"))
created = set()
changed = False


def permitted(name):
    return name and (request.get('admin') or owners.get(identifier(name)) == owner or identifier(name) in created)


def authorize(action, first, second, database, origin):
    global changed
    protected = lambda name: name and identifier(name).startswith('briefsip_')
    if database == 'temp' and first == 'sqlite_temp_master' and action in (sqlite3.SQLITE_READ, sqlite3.SQLITE_UPDATE):
        return sqlite3.SQLITE_OK
    if database not in (None, 'main') or protected(first):
        return sqlite3.SQLITE_DENY
    if action in (sqlite3.SQLITE_SELECT, sqlite3.SQLITE_RECURSIVE, sqlite3.SQLITE_READ):
        return sqlite3.SQLITE_OK
    if action == sqlite3.SQLITE_FUNCTION:
        return sqlite3.SQLITE_DENY if second.lower() == 'load_extension' else sqlite3.SQLITE_OK
    if request.get('readonly'):
        return sqlite3.SQLITE_DENY
    if action == sqlite3.SQLITE_CREATE_TABLE:
        if not first or len(first) > 128 or identifier(first).startswith('sqlite_'):
            return sqlite3.SQLITE_DENY
        created.add(identifier(first))
    elif action in (sqlite3.SQLITE_DROP_TABLE, sqlite3.SQLITE_CREATE_INDEX, sqlite3.SQLITE_DROP_INDEX, sqlite3.SQLITE_ALTER_TABLE):
        table = second if action != sqlite3.SQLITE_DROP_TABLE else first
        if not permitted(table):
            return sqlite3.SQLITE_DENY
        if action == sqlite3.SQLITE_CREATE_INDEX:
            indexes[identifier(first)] = table
    elif action == sqlite3.SQLITE_REINDEX:
        if not permitted(indexes.get(identifier(first))):
            return sqlite3.SQLITE_DENY
    elif action not in (sqlite3.SQLITE_INSERT, sqlite3.SQLITE_UPDATE, sqlite3.SQLITE_DELETE):
        return sqlite3.SQLITE_DENY
    changed = True
    return sqlite3.SQLITE_OK


def cell(value):
    if isinstance(value, bytes):
        return {'base64': base64.b64encode(value).decode('ascii')}
    if isinstance(value, int) and abs(value) > 9007199254740991:
        return {'integer': str(value)}
    return value


try:
    mode = request['mode']
    if mode == 'list':
        tables = db.execute("SELECT m.name,o.owner FROM sqlite_schema m JOIN briefsip_owners o ON o.name=m.name WHERE m.type='table' AND m.name>? ORDER BY m.name LIMIT 21", (request.get('after', ''),)).fetchall()
        items = []
        for name, creator in tables[:20]:
            item = {'name': name, 'owner': creator, 'columns': [{'name': row[1], 'type': row[2], 'notnull': bool(row[3]), 'primary_key': bool(row[5])} for row in db.execute('PRAGMA table_info("' + name.replace('"', '""') + '")')]}
            if len(json.dumps(items + [item]).encode('utf8')) > 120 * 1024:
                break
            items.append(item)
        if tables and not items:
            raise ValueError('Table metadata exceeds the result limit.')
        result = {'tables': items, 'next_after': items[-1]['name'] if len(tables) > len(items) else None}
    else:
        before = {identifier(row[0]): row[0] for row in db.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB 'briefsip_*'")}
        db.execute('BEGIN')
        changes_before = db.total_changes
        db.set_authorizer(authorize)
        sql = 'DROP TABLE "' + request['table'].replace('"', '""') + '"' if mode == 'drop' else request['sql']
        cursor = db.execute(sql, request.get('parameters', []))
        rows = cursor.fetchmany(201) if cursor.description else []
        result = {'columns': [item[0] for item in cursor.description] if cursor.description else [], 'rows': [[cell(value) for value in row] for row in rows[:200]], 'truncated': len(rows) > 200, 'changes': max(cursor.rowcount, 0)}
        cursor.close()
        result['changes'] = db.total_changes - changes_before
        db.set_authorizer(None)
        if len(json.dumps(result).encode('utf8')) > 128 * 1024:
            raise ValueError('Query result exceeds 128 KiB. Choose fewer columns or a smaller page.')
        tables = [row[0] for row in db.execute("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'")]
        if any(name != 'briefsip_owners' and (len(name) > 128 or identifier(name).startswith('briefsip_')) for name in tables):
            raise ValueError('Table name is protected or exceeds 128 characters.')
        after = {identifier(name): name for name in tables if name != 'briefsip_owners'}
        for removed in before.keys() - after.keys():
            db.execute('DELETE FROM briefsip_owners WHERE name=?', (before[removed],))
        for added in after.keys() - before.keys():
            db.execute('INSERT INTO briefsip_owners VALUES (?,?)', (after[added], owner))
        db.execute('COMMIT')
    if len(json.dumps(result).encode('utf8')) > 128 * 1024:
        raise ValueError('Query result exceeds 128 KiB. Choose fewer columns or a smaller page.')
    image = db.serialize() if changed else None
    if image and len(image) > 16 * 1024 * 1024:
        raise ValueError('Shared database limit is 16 MiB.')
    print(json.dumps({'result': result, 'image': base64.b64encode(image).decode('ascii') if image else None}, allow_nan=False))
except (sqlite3.Error, ValueError, OverflowError) as error:
    print(json.dumps({'error': str(error)[:500]}))
finally:
    db.close()
