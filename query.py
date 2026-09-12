import requests
import pandas as pd

url = "https://data.wprdc.org/api/3/action/datastore_search"

params = {
    "resource_id": "b6340d98-69a0-4965-a9b4-3480cea1182b",
    "limit": 1000
}

response = requests.get(url, params=params)
response.raise_for_status()
data = response.json()

records = data["result"]["records"]
print(type(records))