const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

class PodcastUploader {
  constructor(config) {
    this.config = config;
    this.processedEpisodes = new Set();
    this.tempDir = config.tempDir || './temp';
    this.logFile = config.logFile || './podcast-uploader.log';
    this.serverFiles = [];
    this.uploadedFiles = []; // Track files uploaded in current session
  }

  async init() {
    await this.ensureTempDir();
    await this.loadProcessedEpisodes();
    await this.loadServerFiles();
  }

  async log(message, level = 'INFO') {
    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp} [${level}] ${message}`;
    console.log(logEntry);
    
    try {
      await fs.appendFile(this.logFile, logEntry + '\n');
    } catch (error) {
      console.error('Failed to write to log file:', error.message);
    }
  }

  async ensureTempDir() {
    try {
      await fs.mkdir(this.tempDir, { recursive: true });
    } catch (error) {
      throw new Error(`Failed to create temp directory: ${error.message}`);
    }
  }

  async loadProcessedEpisodes() {
    try {
      const data = await fs.readFile('./processed-episodes.json', 'utf8');
      this.processedEpisodes = new Set(JSON.parse(data));
      await this.log(`Loaded ${this.processedEpisodes.size} processed episodes`);
    } catch (error) {
      await this.log('No previous episode history found, starting fresh');
      this.processedEpisodes = new Set();
    }
  }

  async saveProcessedEpisodes() {
    try {
      const episodes = Array.from(this.processedEpisodes);
      await fs.writeFile('./processed-episodes.json', JSON.stringify(episodes, null, 2));
    } catch (error) {
      await this.log(`Failed to save processed episodes: ${error.message}`, 'ERROR');
    }
  }

  async loadServerFiles() {
    try {
      this.serverFiles = await this.apiRequest('GET', `/station/${this.config.azuraCast.stationId}/files`);
      await this.log(`📂 Found ${this.serverFiles.length} existing files on server`);
      
      // Log files by show for debugging
      const filesByShow = new Map();
      this.serverFiles.forEach(file => {
        const show = file.artist || file.album || 'Unknown';
        filesByShow.set(show, (filesByShow.get(show) || 0) + 1);
      });
      
      await this.log(`📈 Files by show: ${Array.from(filesByShow.entries()).map(([show, count]) => `${show}: ${count}`).join(', ')}`);
      
      // Also load and display playlist information
      await this.displayPlaylistInfo();
      
    } catch (error) {
      await this.log(`⚠️ Failed to load server files: ${error.message}`, 'WARN');
      this.serverFiles = [];
    }
  }

  async displayPlaylistInfo() {
    try {
      const playlists = await this.apiRequest('GET', `/station/${this.config.azuraCast.stationId}/playlists`);
      await this.log(`\n📋 Available Playlists:`);
      
      for (const playlist of playlists) {
        const fileCount = await this.getPlaylistFiles(playlist.id);
        await this.log(`📋 ID ${playlist.id}: "${playlist.name}" (${playlist.source}/${playlist.order}) - ${fileCount.length} files`);
        
        if (playlist.source !== 'songs') {
          await this.log(`  ⚠️ Warning: Source '${playlist.source}' may not support manual file assignment`, 'WARN');
        }
      }
      
    } catch (error) {
      await this.log(`⚠️ Could not load playlist information: ${error.message}`, 'WARN');
    }
  }

  async cleanupOrphanedFiles() {
    try {
      await this.log('\n🧹 Starting orphaned file cleanup...');
      
      // Get default playlist from config
      const defaultPlaylistId = this.config.azuraCast.defaultPlaylist;
      if (!defaultPlaylistId) {
        await this.log('⚠️ No defaultPlaylist configured, skipping orphaned file cleanup', 'WARN');
        await this.log('💡 Add "defaultPlaylist": YOUR_PLAYLIST_ID to azuraCast config to enable this feature');
        return;
      }
      
      await this.log(`📋 Default playlist ID: ${defaultPlaylistId}`);
      
      // Find files assigned to the default playlist by checking file.playlists property
      const filesInDefaultPlaylist = this.serverFiles.filter(file => {
        const filePlaylists = file.playlists || [];
        return filePlaylists.some(playlist => 
          playlist.id === defaultPlaylistId || playlist.id === defaultPlaylistId.toString()
        );
      });
      
      await this.log(`📋 Found ${filesInDefaultPlaylist.length} files in default playlist`);
      
      // Find orphaned files (on server but not in default playlist)
      const orphanedFiles = this.serverFiles.filter(file => {
        const filePlaylists = file.playlists || [];
        return !filePlaylists.some(playlist => 
          playlist.id === defaultPlaylistId || playlist.id === defaultPlaylistId.toString()
        );
      });
      
      if (orphanedFiles.length === 0) {
        await this.log('✅ No orphaned files found - all server files are in the default playlist');
        return;
      }
      
      await this.log(`🗑️ Found ${orphanedFiles.length} orphaned files to delete:`);
      orphanedFiles.forEach(file => {
        const playlists = file.playlists || [];
        this.log(`  - "${file.title}" (ID: ${file.id}) by ${file.artist || 'Unknown'} (playlists: ${JSON.stringify(playlists)})`);
      });
      
      let deletedCount = 0;
      let failedCount = 0;
      
      // Delete orphaned files
      for (const file of orphanedFiles) {
        try {
          await this.log(`🗑️ Deleting orphaned file: "${file.title}" (ID: ${file.id})`);
          
          const result = await this.apiRequest('DELETE', `/station/${this.config.azuraCast.stationId}/file/${file.id}`);
          
          deletedCount++;
          await this.log(`✅ Successfully deleted file ID ${file.id}`);
          
          // Small delay between deletions to avoid overwhelming the API
          await new Promise(resolve => setTimeout(resolve, 500));
          
        } catch (error) {
          failedCount++;
          await this.log(`❌ Failed to delete file ID ${file.id}: ${error.message}`, 'ERROR');
        }
      }
      
      await this.log(`\n🧹 Orphaned file cleanup complete:`);
      await this.log(`✅ Successfully deleted: ${deletedCount} files`);
      await this.log(`❌ Failed to delete: ${failedCount} files`);
      
      // Reload server files after cleanup
      if (deletedCount > 0) {
        await this.log('🔄 Reloading server files after cleanup...');
        await this.loadServerFiles();
      }
      
    } catch (error) {
      await this.log(`❌ Orphaned file cleanup failed: ${error.message}`, 'ERROR');
    }
  }

  async apiRequest(method, endpoint, data = null) {
    const url = `https://${this.config.azuraCast.host}/api${endpoint}`;
    
    return new Promise((resolve, reject) => {
      const options = {
        method,
        headers: {
          'X-API-Key': this.config.azuraCast.apiKey,
          'Accept': 'application/json'
        }
      };

      let postData = null;
      if (data) {
        postData = JSON.stringify(data);
        options.headers['Content-Type'] = 'application/json';
        options.headers['Content-Length'] = Buffer.byteLength(postData);
      }

      const req = https.request(url, options, (response) => {
        let responseData = '';
        response.on('data', (chunk) => { responseData += chunk; });
        response.on('end', () => {
          if (response.statusCode >= 200 && response.statusCode < 300) {
            try {
              const result = responseData ? JSON.parse(responseData) : {};
              resolve(result);
            } catch (err) {
              resolve({ success: true }); // Some endpoints return non-JSON success
            }
          } else {
            reject(new Error(`API ${method} ${endpoint} failed: ${response.statusCode} - ${responseData}`));
          }
        });
      });

      req.on('error', reject);
      req.setTimeout(60000, () => {
        req.destroy();
        reject(new Error(`API request timeout: ${method} ${endpoint}`));
      });

      if (postData) req.write(postData);
      req.end();
    });
  }

  async fetchFeed(url) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https:') ? https : http;
      
      const request = client.get(url, (response) => {
        // Handle redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          return this.fetchFeed(response.headers.location).then(resolve).catch(reject);
        }
        
        if (response.statusCode !== 200) {
          return reject(new Error(`HTTP ${response.statusCode}: ${response.statusMessage}`));
        }
        
        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => resolve(data));
      });
      
      request.on('error', reject);
      request.setTimeout(30000, () => {
        request.destroy();
        reject(new Error('Feed fetch timeout'));
      });
    });
  }

  parseRSSFeed(xmlContent) {
    const extractTag = (content, tag) => {
      const match = content.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
      return match ? match[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim() : '';
    };

    const extractAttr = (content, tag, attr) => {
      const match = content.match(new RegExp(`<${tag}[^>]*${attr}=["']([^"']*?)["'][^>]*>`, 'i'));
      return match ? match[1] : '';
    };

    // Extract show metadata
    const showMetadata = {
      title: extractTag(xmlContent, 'title'),
      description: extractTag(xmlContent, 'description'),
      author: extractTag(xmlContent, 'itunes:author') || extractTag(xmlContent, 'managingEditor'),
      image: extractAttr(xmlContent, 'itunes:image', 'href') || this.extractImageFromImageTag(xmlContent)
    };

    // Extract episodes
    const itemRegex = /<item[\s\S]*?<\/item>/gi;
    const items = xmlContent.match(itemRegex) || [];
    
    const episodes = items.map(item => ({
      title: extractTag(item, 'title'),
      description: extractTag(item, 'description'),
      pubDate: new Date(extractTag(item, 'pubDate') || Date.now()),
      enclosureUrl: extractAttr(item, 'enclosure', 'url'),
      guid: extractTag(item, 'guid') || crypto.createHash('md5').update(extractTag(item, 'title') + extractAttr(item, 'enclosure', 'url')).digest('hex'),
      duration: extractTag(item, 'itunes:duration'),
      image: extractAttr(item, 'itunes:image', 'href')
    })).filter(ep => ep.enclosureUrl); // Only episodes with audio

    return { showMetadata, episodes };
  }

  extractImageFromImageTag(xmlContent) {
    const imageSection = xmlContent.match(/<image[^>]*>([\s\S]*?)<\/image>/i);
    if (imageSection) {
      const urlMatch = imageSection[1].match(/<url[^>]*>([^<]+)<\/url>/i);
      if (urlMatch) return urlMatch[1].trim();
    }
    return '';
  }

  async downloadFile(url, filepath, showProgress = true) {
    return new Promise((resolve, reject) => {
      const client = url.startsWith('https:') ? https : http;
      const file = require('fs').createWriteStream(filepath);
      
      const request = client.get(url, (response) => {
        // Handle redirects
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          file.close();
          return this.downloadFile(response.headers.location, filepath, showProgress).then(resolve).catch(reject);
        }
        
        if (response.statusCode !== 200) {
          file.close();
          return reject(new Error(`Download failed: HTTP ${response.statusCode}`));
        }
        
        let downloadedBytes = 0;
        const totalBytes = parseInt(response.headers['content-length'] || '0');
        let lastLogTime = 0;
        
        response.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          
          // Show progress for large files
          if (showProgress && totalBytes > 10 * 1024 * 1024) {
            const now = Date.now();
            if (now - lastLogTime > 10000) { // Every 10 seconds
              const progress = ((downloadedBytes / totalBytes) * 100).toFixed(1);
              this.log(`Download progress: ${progress}% (${(downloadedBytes / 1024 / 1024).toFixed(1)}MB)`);
              lastLogTime = now;
            }
          }
        });
        
        response.pipe(file);
        file.on('finish', () => {
          file.close();
          resolve();
        });
      });
      
      request.on('error', (err) => {
        file.close();
        reject(err);
      });
      
      request.setTimeout(600000, () => { // 10 minute timeout
        request.destroy();
        file.close();
        reject(new Error('Download timeout'));
      });
    });
  }

  async uploadFile(filePath, episode, showMetadata) {
    const fileStats = await fs.stat(filePath);
    const fileSizeMB = fileStats.size / 1024 / 1024;
    const fileName = path.basename(filePath);
    
    await this.log(`📤 Uploading: ${fileName} (${fileSizeMB.toFixed(2)}MB)`);
    
    // Warn about very large files
    if (fileSizeMB > 200) {
      await this.log(`⚠️ Large file detected (${fileSizeMB.toFixed(2)}MB) - this may require more memory`, 'WARN');
    }
    
    // Read and encode file
    const fileBuffer = await fs.readFile(filePath);
    const base64Data = fileBuffer.toString('base64');
    
    const result = await this.apiRequest('POST', `/station/${this.config.azuraCast.stationId}/files`, {
      path: fileName,
      file: base64Data
    });
    
    if (!result.id) {
      throw new Error('Upload failed: No file ID returned');
    }
    
    await this.log(`✅ Upload successful, file ID: ${result.id}`);
    return result;
  }

  async waitForFileIndexing(fileId, maxRetries = 10) {
    await this.log(`⏳ Waiting for file ${fileId} to be indexed...`);
    
    for (let retry = 0; retry < maxRetries; retry++) {
      const delay = Math.min(30000 + (retry * 30000), 300000); // 30s to 5min max
      await new Promise(resolve => setTimeout(resolve, delay));
      
      try {
        await this.apiRequest('GET', `/station/${this.config.azuraCast.stationId}/file/${fileId}`);
        await this.log(`✅ File ${fileId} indexed successfully`);
        return true;
      } catch (error) {
        await this.log(`Indexing check ${retry + 1}/${maxRetries} failed, retrying...`);
      }
    }
    
    throw new Error(`File ${fileId} indexing timeout after ${maxRetries} attempts`);
  }

  async updateFileMetadata(fileId, episode, showMetadata) {
    const metadata = {
      title: episode.title || 'Unknown Episode',
      artist: showMetadata.author || 'Unknown',
      album: showMetadata.title || 'Podcast'
    };
    
    if (episode.description) {
      metadata.comment = episode.description.substring(0, 500);
    }
    
    await this.apiRequest('PUT', `/station/${this.config.azuraCast.stationId}/file/${fileId}`, metadata);
    await this.log(`✅ Metadata updated for file ${fileId}`);
  }

  async uploadArtwork(fileId, imagePath) {
    try {
      const FormData = require('form-data');
      const form = new FormData();
      const artStream = require('fs').createReadStream(imagePath);
      
      form.append('art', artStream, {
        filename: path.basename(imagePath),
        contentType: 'image/jpeg'
      });
      
      await new Promise((resolve, reject) => {
        const options = {
          method: 'POST',
          headers: {
            'X-API-Key': this.config.azuraCast.apiKey,
            ...form.getHeaders()
          }
        };
        
        const req = https.request(
          `https://${this.config.azuraCast.host}/api/station/${this.config.azuraCast.stationId}/art/${fileId}`,
          options,
          (response) => {
            let data = '';
            response.on('data', (chunk) => { data += chunk; });
            response.on('end', () => {
              if (response.statusCode >= 200 && response.statusCode < 300) {
                resolve();
              } else {
                reject(new Error(`Artwork upload failed: ${response.statusCode} ${data}`));
              }
            });
          }
        );
        
        req.on('error', reject);
        req.setTimeout(60000, () => {
          req.destroy();
          reject(new Error('Artwork upload timeout'));
        });
        
        form.pipe(req);
      });
      
      await this.log(`✅ Artwork uploaded for file ${fileId}`);
    } catch (error) {
      if (error.code === 'MODULE_NOT_FOUND' && error.message.includes('form-data')) {
        throw new Error('form-data module required. Run: npm install form-data');
      }
      throw error;
    }
  }

  async getPlaylistFiles(playlistId) {
    try {
      const files = await this.apiRequest('GET', `/station/${this.config.azuraCast.stationId}/playlist/${playlistId}/order`);
      
      // Debug: Log the raw response to understand the structure
      await this.log(`🔍 Raw playlist API response for playlist ${playlistId}: ${JSON.stringify(files)}`, 'DEBUG');
      
      if (Array.isArray(files)) {
        // Try different approaches depending on the response format
        let fileIds = [];
        
        if (files.length > 0) {
          const firstItem = files[0];
          await this.log(`🔍 First playlist item structure: ${JSON.stringify(firstItem)}`, 'DEBUG');
          
          if (typeof firstItem === 'number') {
            // Simple array of numbers
            fileIds = files.map(f => parseInt(f)).filter(f => f > 0);
          } else if (typeof firstItem === 'string') {
            // Array of string numbers
            fileIds = files.map(f => parseInt(f) || 0).filter(f => f > 0);
          } else if (typeof firstItem === 'object' && firstItem.id) {
            // Array of objects with id property
            fileIds = files.map(f => parseInt(f.id) || 0).filter(f => f > 0);
          } else if (typeof firstItem === 'object' && firstItem.media_id) {
            // Array of objects with media_id property
            fileIds = files.map(f => parseInt(f.media_id) || 0).filter(f => f > 0);
          }
        }
        
        await this.log(`🔍 Extracted ${fileIds.length} file IDs from playlist: ${fileIds.join(', ')}`, 'DEBUG');
        return fileIds;
      }
      
      await this.log(`🔍 Playlist response is not an array: ${typeof files}`, 'DEBUG');
      return [];
      
    } catch (error) {
      await this.log(`Could not get playlist files for playlist ${playlistId}: ${error.message}`, 'WARN');
      return [];
    }
  }

  async addFilesToPlaylist(playlistId, fileIds) {
    try {
      await this.log(`📋 Adding ${fileIds.length} files to playlist ${playlistId} via file metadata...`);
      
      let successCount = 0;
      let failCount = 0;
      
      for (const fileId of fileIds) {
        try {
          // Update each file to include the playlist assignment
          await this.apiRequest('PUT', `/station/${this.config.azuraCast.stationId}/file/${fileId}`, {
            playlists: [playlistId.toString()]
          });
          
          successCount++;
          await this.log(`✅ File ${fileId} assigned to playlist ${playlistId}`);
          
        } catch (error) {
          failCount++;
          await this.log(`❌ Failed to assign file ${fileId} to playlist ${playlistId}: ${error.message}`, 'ERROR');
        }
        
        // Small delay between file updates
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      await this.log(`📋 Playlist assignment complete: ${successCount} success, ${failCount} failed`);
      
      return { 
        success: successCount > 0, 
        added: successCount,
        failed: failCount,
        method: 'file_metadata_update'
      };
      
    } catch (error) {
      await this.log(`❌ Failed to add files to playlist ${playlistId}: ${error.message}`, 'ERROR');
      throw error;
    }
  }

  episodeExists(episode, showMetadata) {
    const episodeTitle = episode.title.toLowerCase().trim();
    const showAuthor = (showMetadata.author || '').toLowerCase().trim();
    const showTitle = (showMetadata.title || '').toLowerCase().trim();
    
    return this.serverFiles.some(file => {
      const fileTitle = (file.title || '').toLowerCase().trim();
      const fileArtist = (file.artist || '').toLowerCase().trim();
      const fileAlbum = (file.album || '').toLowerCase().trim();
      
      // Exact title match with show match
      return fileTitle === episodeTitle && 
             (fileArtist === showAuthor || fileAlbum === showTitle || 
              fileArtist.includes(showAuthor.substring(0, 10)) || 
              fileAlbum.includes(showTitle.substring(0, 10)));
    });
  }

  async processEpisode(episode, showMetadata, playlistId) {
    const startTime = Date.now();
    await this.log(`\n🎧 Processing: "${episode.title}" from ${showMetadata.title}`);
    
    // Generate unique filename
    const url = new URL(episode.enclosureUrl);
    const extension = path.extname(url.pathname) || '.mp3';
    const filename = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}${extension}`;
    const filepath = path.join(this.tempDir, filename);
    
    let imagePath = null;
    let uploadedFileId = null;
    
    try {
      // Download audio file
      await this.log(`📥 Downloading audio...`);
      await this.downloadFile(episode.enclosureUrl, filepath);
      
      const stats = await fs.stat(filepath);
      if (stats.size === 0) throw new Error('Downloaded file is empty');
      await this.log(`✅ Downloaded ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
      
      // Download artwork if available
      const imageUrl = episode.image || showMetadata.image;
      if (imageUrl) {
        try {
          const imageExt = path.extname(new URL(imageUrl).pathname) || '.jpg';
          imagePath = path.join(this.tempDir, `${Date.now()}_artwork${imageExt}`);
          await this.downloadFile(imageUrl, imagePath, false);
          
          const imageStats = await fs.stat(imagePath);
          if (imageStats.size > 0) {
            await this.log(`✅ Downloaded artwork: ${(imageStats.size / 1024).toFixed(2)} KB`);
          } else {
            await fs.unlink(imagePath);
            imagePath = null;
          }
        } catch (error) {
          await this.log(`⚠️ Artwork download failed: ${error.message}`, 'WARN');
          imagePath = null;
        }
      }
      
      // Upload file
      const uploadResult = await this.uploadFile(filepath, episode, showMetadata);
      uploadedFileId = uploadResult.id;
      
      // Wait for indexing
      await this.waitForFileIndexing(uploadedFileId);
      
      // Update metadata
      await this.log(`📝 Updating metadata...`);
      await this.updateFileMetadata(uploadedFileId, episode, showMetadata);
      
      // Upload artwork
      if (imagePath) {
        try {
          await this.log(`🎨 Uploading artwork...`);
          await this.uploadArtwork(uploadedFileId, imagePath);
        } catch (error) {
          await this.log(`⚠️ Artwork upload failed: ${error.message}`, 'WARN');
        }
      }
      
      // Assign to playlist immediately
      if (playlistId) {
        try {
          await this.log(`📋 Adding to playlist ${playlistId}...`);
          await this.apiRequest('PUT', `/station/${this.config.azuraCast.stationId}/file/${uploadedFileId}`, {
            playlists: [playlistId.toString()]
          });
          await this.log(`✅ File ${uploadedFileId} assigned to playlist ${playlistId}`);
        } catch (error) {
          await this.log(`⚠️ Playlist assignment failed: ${error.message}`, 'WARN');
        }
      }
      
      const processingTime = ((Date.now() - startTime) / 1000).toFixed(1);
      await this.log(`✅ Successfully processed "${episode.title}" in ${processingTime}s`);
      
      return { success: true, fileId: uploadedFileId };
      
    } catch (error) {
      await this.log(`❌ Failed to process "${episode.title}": ${error.message}`, 'ERROR');
      throw error;
    } finally {
      // Cleanup
      try {
        if (filepath) await fs.unlink(filepath);
        if (imagePath) await fs.unlink(imagePath);
      } catch (error) {
        // Ignore cleanup errors
      }
    }
  }

  async cleanupOldEpisodes() {
    try {
      await this.log(`\n🧹 Starting episode cleanup to maintain configured limits...`);
      
      // Get all current files from the station
      const allFiles = await this.apiRequest('GET', `/station/${this.config.azuraCast.stationId}/files`);
      await this.log(`📂 Found ${allFiles.length} total files on station`);
      
      // Get current show metadata for matching
      const showMetadataMap = new Map();
      for (const showConfig of this.config.shows) {
        if (showConfig.enabled === false) continue;
        
        try {
          const feedData = await this.fetchFeed(showConfig.rssUrl);
          const { showMetadata } = this.parseRSSFeed(feedData);
          showMetadataMap.set(showConfig.rssUrl, { 
            ...showMetadata, 
            maxEpisodes: showConfig.maxEpisodes || 5,
            maxAgeDays: showConfig.maxAgeDays || 30,
            playlistId: showConfig.playlistId
          });
        } catch (error) {
          await this.log(`⚠️ Could not fetch show metadata for cleanup: ${showConfig.rssUrl}`, 'WARN');
        }
      }
      
      let totalRemoved = 0;
      
      // Process each show
      for (const [rssUrl, showData] of showMetadataMap) {
        try {
          // Find files belonging to this show
          const showFiles = allFiles.filter(file => {
            const fileArtist = (file.artist || '').toLowerCase().trim();
            const fileAlbum = (file.album || '').toLowerCase().trim();
            const showAuthor = (showData.author || '').toLowerCase().trim();
            const showTitle = (showData.title || '').toLowerCase().trim();
            
            return (fileArtist === showAuthor || fileAlbum === showTitle ||
                    fileArtist.includes(showAuthor.substring(0, 10)) ||
                    fileAlbum.includes(showTitle.substring(0, 10)));
          });
          
          // Calculate age cutoff date
          const maxAgeDays = showData.maxAgeDays || 30;
          const cutoffDate = new Date();
          cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);
          const cutoffTimestamp = Math.floor(cutoffDate.getTime() / 1000);
          
          await this.log(`📅 ${showData.title}: Age cutoff is ${maxAgeDays} days (${cutoffDate.toDateString()})`, 'DEBUG');
          
          // Sort by upload date (newest first)
          showFiles.sort((a, b) => (b.uploaded_at || 0) - (a.uploaded_at || 0));
          
          // Find files to remove: NOT in newest maxEpisodes OR older than maxAgeDays
          const filesToRemove = showFiles.filter((file, index) => {
            const fileAge = file.uploaded_at ? Math.floor((Date.now() / 1000 - file.uploaded_at) / (24 * 60 * 60)) : 0;
            
            const beyondEpisodeLimit = index >= showData.maxEpisodes; // Not in the newest X episodes
            const tooOld = fileAge > maxAgeDays; // Older than age limit
            
            return beyondEpisodeLimit || tooOld; // Remove if EITHER condition is true
          });
          
          if (filesToRemove.length === 0) {
            await this.log(`✅ ${showData.title}: ${showFiles.length}/${showData.maxEpisodes} episodes, none older than ${maxAgeDays} days - no cleanup needed`);
            continue;
          }
          
          await this.log(`🧹 ${showData.title}: Removing ${filesToRemove.length} episodes (${showFiles.length - filesToRemove.length} will remain)`);
          
          // Remove episodes from playlist (don't delete files)
          for (const file of filesToRemove) {
            try {
              // Get current file info for debugging
              const currentFile = await this.apiRequest('GET', `/station/${this.config.azuraCast.stationId}/file/${file.id}`);
              const currentPlaylists = currentFile.playlists || [];
              
              await this.log(`🔍 File ${file.id} currently in playlists: ${JSON.stringify(currentPlaylists)}`, 'DEBUG');
              
              // Determine removal reason for logging
              const fileAge = file.uploaded_at ? Math.floor((Date.now() / 1000 - file.uploaded_at) / (24 * 60 * 60)) : 0;
              const fileIndex = showFiles.indexOf(file);
              const beyondLimit = fileIndex >= showData.maxEpisodes;
              const tooOld = fileAge > maxAgeDays;
              
              let reason = '';
              if (tooOld && beyondLimit) {
                reason = `${fileAge} days old & beyond episode limit`;
              } else if (tooOld) {
                reason = `${fileAge} days old`;
              } else {
                reason = 'beyond episode limit';
              }
              
              // Remove from all playlists by setting empty array
              const updateResult = await this.apiRequest('PUT', `/station/${this.config.azuraCast.stationId}/file/${file.id}`, {
                playlists: []
              });
              
              await this.log(`✅ API response: ${JSON.stringify(updateResult)}`, 'DEBUG');
              await this.log(`📤 Removed from all playlists: "${file.title}" (${reason})`);
              totalRemoved++;
              
              // Small delay between updates
              await new Promise(resolve => setTimeout(resolve, 500));
              
            } catch (error) {
              await this.log(`❌ Failed to remove file ${file.id} from playlists: ${error.message}`, 'ERROR');
            }
          }
          
        } catch (error) {
          await this.log(`❌ Failed to cleanup show ${showData.title}: ${error.message}`, 'ERROR');
        }
      }
      
      await this.log(`\n🧹 Cleanup Complete! Removed ${totalRemoved} episodes from playlists (based on episode limits and age cutoffs)`);
      
    } catch (error) {
      await this.log(`❌ Cleanup failed: ${error.message}`, 'ERROR');
    }
  }

  async run() {
    try {
      await this.log('🚀 Starting AzuraCast Podcast Uploader');
      await this.init();
      
      // Clean up orphaned files first
      await this.cleanupOrphanedFiles();
      
      // Collect episodes from all shows
      const allEpisodes = [];
      const showMetadataMap = new Map();
      
      for (const showConfig of this.config.shows) {
        if (showConfig.enabled === false) continue;
        
        try {
          await this.log(`\n📡 Fetching: ${showConfig.rssUrl}`);
          const feedData = await this.fetchFeed(showConfig.rssUrl);
          const { showMetadata, episodes } = this.parseRSSFeed(feedData);
          
          showMetadataMap.set(showConfig.rssUrl, showMetadata);
          await this.log(`✅ ${showMetadata.title}: ${episodes.length} episodes`);
          
          // Filter recent episodes
          const cutoffDate = new Date();
          cutoffDate.setDate(cutoffDate.getDate() - (showConfig.maxAgeDays || 30));
          
          const recentEpisodes = episodes
            .filter(ep => ep.pubDate > cutoffDate)
            .slice(0, showConfig.maxEpisodes || 5)
            .map(ep => ({ ...ep, showConfig, showMetadata }));
          
          allEpisodes.push(...recentEpisodes);
          
        } catch (error) {
          await this.log(`❌ Failed to fetch ${showConfig.rssUrl}: ${error.message}`, 'ERROR');
        }
      }
      
      if (allEpisodes.length === 0) {
        await this.log('No episodes found to process');
        return;
      }
      
      // Sort chronologically (oldest first) and filter new episodes
      allEpisodes.sort((a, b) => a.pubDate - b.pubDate);
      
      const newEpisodes = allEpisodes.filter(episode => {
        if (this.processedEpisodes.has(episode.guid)) return false;
        if (this.episodeExists(episode, episode.showMetadata)) {
          this.processedEpisodes.add(episode.guid);
          return false;
        }
        return true;
      });
      
      await this.log(`\n📊 Summary: ${allEpisodes.length} total, ${newEpisodes.length} new episodes to upload`);
      
      if (newEpisodes.length === 0) {
        await this.log('✅ All episodes up to date!');
        // Still run cleanup even when no new episodes
        await this.cleanupOldEpisodes();
        await this.saveProcessedEpisodes();
        return;
      }
      
      // Process episodes
      await this.log('\n🎵 Starting episode processing...');
      let uploaded = 0, failed = 0;
      
      for (const episode of newEpisodes) {
        try {
          await this.processEpisode(episode, episode.showMetadata, episode.showConfig.playlistId);
          this.processedEpisodes.add(episode.guid);
          uploaded++;
          
          // Small delay between episodes
          if (uploaded < newEpisodes.length) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
          
        } catch (error) {
          failed++;
        }
      }
      
      await this.log(`\n🎉 Process Complete! ✅ ${uploaded} successful, ❌ ${failed} failed`);
      await this.saveProcessedEpisodes();
      
      // Always run cleanup to maintain episode limits
      await this.cleanupOldEpisodes();
      
    } catch (error) {
      await this.log(`💥 Fatal error: ${error.message}`, 'ERROR');
      process.exit(1);
    }
  }
}

// Main execution
async function main() {
  try {
    const configData = await fs.readFile('./config.json', 'utf8');
    const config = JSON.parse(configData);
    
    const uploader = new PodcastUploader(config);
    await uploader.run();
    
  } catch (error) {
    console.error('❌ Failed to start:', error.message);
    console.error('Make sure config.json exists and is properly formatted.');
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = PodcastUploader;
