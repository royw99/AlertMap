import requests
import pandas as pd

url = "https://data.wprdc.org/api/3/action/datastore_search"

# params = {
#     "resource_id": "b6340d98-69a0-4965-a9b4-3480cea1182b",
#     "limit": 10000
# }

# response = requests.get(url, params=params)
# response.raise_for_status()
# data = response.json()

# records = data["result"]["records"]

# df = pd.DataFrame(records)

# # Dispatch priority, most life-threatening first (this dataset is Fire/EMS only,
# # so it has no police/crime categories like burglary or stabbing).
# severity_order = ["F0", "Q0", "Q1", "1A", "2A", "F1", "F2", "Q2", "F3", "Q3", "Q4", "F5"]
# severity_rank = {code: i for i, code in enumerate(severity_order)}

# cleaned = pd.DataFrame({
#     "created_date": df["call_year"].astype(str) + "-" + df["call_quarter"],
#     "request_type": df["description_short"],
#     "neighborhood": df["city_name"],
#     "_severity_rank": df["priority"].map(severity_rank),
# })

# cleaned = cleaned.sort_values(["created_date", "_severity_rank"]).drop(columns="_severity_rank")

# print(cleaned)

# --- Police incident data (real crime categories, e.g. robbery, assault, burglary) ---

police_params = {
    "resource_id": "044f2016-1dfd-4ab0-bc1e-065da05fca2e",  # Police Incident Blotter (UCR Coded)
    "limit": 10000,
    "sort": "\"INCIDENTTIME\" desc"
}

police_response = requests.get(url, params=police_params)
police_response.raise_for_status()
police_data = police_response.json()

police_df = pd.DataFrame(police_data["result"]["records"])

# HIERARCHY is the UCR severity ranking baked into the data: 1 = murder, ascending = less severe.
police_cleaned = pd.DataFrame({
    "created_date": police_df["INCIDENTTIME"],
    "request_type": police_df["INCIDENTHIERARCHYDESC"],
    "neighborhood": police_df["INCIDENTNEIGHBORHOOD"],
    "_severity_rank": police_df["HIERARCHY"],
})

police_cleaned = police_cleaned.sort_values(["created_date", "_severity_rank"]).drop(columns="_severity_rank")

print(police_cleaned)

# --- Neighborhood safety score, aggregated from police incidents ---

# Weight each incident by severity: HIERARCHY 1 (murder) is the most violent, so invert it
# into a weight; unclassified incidents (HIERARCHY 0 / "NA") contribute no weight.
police_df["_severity_weight"] = police_df["HIERARCHY"].apply(lambda h: 1 / h if h and h > 0 else 0)

neighborhood_safety = (
    police_df.groupby("INCIDENTNEIGHBORHOOD")["_severity_weight"]
    .sum()
    .reset_index(name="_weighted_incidents")
)

# Normalize to a 0-100 risk score relative to this sample: 0 = safest, 100 = highest risk.
min_score = neighborhood_safety["_weighted_incidents"].min()
max_score = neighborhood_safety["_weighted_incidents"].max()
neighborhood_safety["risk_score"] = (
    (neighborhood_safety["_weighted_incidents"] - min_score) / (max_score - min_score) * 100
).round(1)


def risk_category(score):
    if score < 12:
        return "Safe"
    elif score < 25:
        return "Low Risk"
    elif score < 45:
        return "Moderate Risk"
    elif score < 75:
        return "High Risk"
    else:
        return "Very High Risk"


neighborhood_safety["safety_category"] = neighborhood_safety["risk_score"].apply(risk_category)
neighborhood_safety = neighborhood_safety.rename(columns={"INCIDENTNEIGHBORHOOD": "neighborhood"})
neighborhood_safety = neighborhood_safety[["neighborhood", "risk_score", "safety_category"]]
neighborhood_safety = neighborhood_safety.sort_values("risk_score", ascending=False)

print(neighborhood_safety)