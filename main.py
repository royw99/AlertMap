from importlib import import_module

RemoteCKAN = import_module("ckanapi").RemoteCKAN

rc = RemoteCKAN('https://data.wprdc.ord/')

result = rc.action.dataset_search(
    resource_id = "b6340d98-69a0-4965-a9b4-3480cea1182b",
    limit=5
)

print(result['records'])