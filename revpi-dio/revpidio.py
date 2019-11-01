import revpimodio2
import sys
#def eventfunction(ioname, iovalue):
        #print("Event {} has the value of {}".format(ioname,iovalue))
#       print(iovalue)

rpi = revpimodio2.RevPiModIO(autorefresh=True)

#rpi.handlesignalend()

pin_input = sys.argv[1]

print(int(rpi.io[pin_input].value))

#print("Starting main loop")
#rpi.mainloop()