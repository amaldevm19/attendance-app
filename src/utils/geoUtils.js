/**
 * Calculates the distance between two points in meters using the Haversine formula.
 */
export const getDistance = (lat1, lon1, lat2, lon2) => {
    const R = 6371e3; // Earth radius in meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
              
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c; 
};

/**
 * Finds the nearest site from a list within a specific threshold.
 */
export const findNearestSite = (userLat, userLon, sites, threshold = 100) => {
    let matchedSite = null; // Start with null
    let minDistance = Infinity;

    sites.forEach(site => {
        const dist = getDistance(userLat, userLon, site.latitude, site.longitude);
        if (dist < minDistance) {
            minDistance = dist;
            if (dist <= threshold) {
                matchedSite = site; // Store the whole site object
            }
        }
    });

    return { 
        id: matchedSite ? matchedSite.id : null, 
        site_name: matchedSite ? matchedSite.site_name : "Off-site", 
        distance: Math.round(minDistance) 
    };
};