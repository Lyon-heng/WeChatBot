export async function localEmbeddings(settings,texts,{signal}={}){
 if(!settings.embeddingEnabled)throw Error('EMBEDDING_DISABLED');
 const endpoint=new URL(settings.embeddingUrl??'');if(endpoint.protocol!=='http:'||endpoint.hostname!=='127.0.0.1'||!endpoint.port||endpoint.username||endpoint.password||endpoint.search||endpoint.hash||endpoint.pathname!=='/v1/embeddings')throw Error('EMBEDDING_LOCAL_ENDPOINT_REQUIRED');
 if(!Array.isArray(texts)||!texts.length||texts.length>101||texts.some(t=>typeof t!=='string'||!t.trim()||t.length>500)||JSON.stringify(texts).length>52000)throw Error('EMBEDDING_INPUT_INVALID');
 const response=await fetch(endpoint,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:settings.embeddingModel,input:texts}),signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(4500)])});if(!response.ok)throw Error('EMBEDDING_SERVICE_UNAVAILABLE');
 const reader=response.body.getReader(),chunks=[];let size=0;try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>2*1024*1024)throw Error('EMBEDDING_RESPONSE_LIMIT');chunks.push(value);}}finally{await reader.cancel().catch(()=>{});}
 const body=JSON.parse(Buffer.concat(chunks).toString()),rows=body.data;if(!Array.isArray(rows)||rows.length!==texts.length)throw Error('EMBEDDING_RESPONSE_INVALID');const vectors=Array(texts.length);let dimensions;
 for(const row of rows){const v=row.embedding;if(!Number.isInteger(row.index)||row.index<0||row.index>=texts.length||vectors[row.index]||!Array.isArray(v)||!v.length||v.length>2048||v.some(n=>!Number.isFinite(n))||Math.hypot(...v)===0||dimensions&&v.length!==dimensions)throw Error('EMBEDDING_VECTOR_INVALID');dimensions=v.length;vectors[row.index]=v;}return vectors;
}
