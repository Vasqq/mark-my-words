import sys,re
inc={'CORE':open('core.js').read(),'RULER':open('inc/ruler.js').read(),'HIST':open('inc/hist.js').read()}
import os
for f in os.listdir('inc'):
    k=f.split('.')[0].upper()
    inc.setdefault(k,open('inc/'+f).read())
for n in sys.argv[1:]:
    s=open(n+'.src.html').read()
    s=re.sub(r'/\*@([A-Z]+)\*/',lambda m:inc[m.group(1)],s)
    open('../perpl-'+n+'.html','w').write(s)
