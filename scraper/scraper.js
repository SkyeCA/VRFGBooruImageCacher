const fs = require('fs/promises');

// Configuration
const API_BASE_URL = 'https://vrfg.eu';
const API_USERNAME = ''; // Add your username
const API_TOKEN = '';  // Your UUID token
const OUTPUT_FILE = 'scraped_data.json';

async function scrapeBooru() {
    let offset = 0;
    const limit = 1000;
    let hasMore = true;
    const allPosts = [];

    // Szurubooru expects base64(username:token)
    const encodedCredentials = Buffer.from(`${API_USERNAME}:${API_TOKEN}`).toString('base64');

    console.log('Starting scrape...');

    while (hasMore) {
        const url = `${API_BASE_URL}/api/posts/?limit=${limit}&offset=${offset}&fields=id,type,safety,tags,version`;
        
        try {
            console.log(`Fetching up to ${limit} posts at offset ${offset}...`);
            
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    // Send the base64 encoded credentials
                    'Authorization': `Token ${encodedCredentials}`,
                    'Accept': 'application/json'
                }
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status} - ${await response.text()}`);
            }

            const data = await response.json();
            const results = data.results || [];

            const processedImages = results
                .filter(item => item.type === 'image')
                .map(item => {
                    const tagNames = item.tags ? item.tags.flatMap(tag => tag.names) : [];
                    
                    return {
                        id: item.id,
                        uploadDate: item.version,
                        url: `https://imageproxy.vore.my/image?id=${item.id}`,
                        safety: item.safety,
                        tags: tagNames
                    };
                });

            allPosts.push(...processedImages);

            if (results.length < limit) {
                hasMore = false;
                console.log(`\nFinished fetching. Total items from API: ${data.total}`);
            } else {
                offset += limit;
            }

        } catch (error) {
            console.error(`\nAn error occurred while fetching at offset ${offset}:`, error);
            console.log('Saving what we have so far...');
            break; 
        }
    }

    try {
        console.log(`Writing ${allPosts.length} processed images to ${OUTPUT_FILE}...`);
        await fs.writeFile(OUTPUT_FILE, JSON.stringify(allPosts, null, 2), 'utf-8');
        console.log('Done! Data successfully saved.');
    } catch (writeError) {
        console.error('Failed to write to file:', writeError);
    }
}

// Execute the function
scrapeBooru();